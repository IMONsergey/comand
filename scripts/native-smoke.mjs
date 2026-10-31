#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHub } from '../dist/hub/server.js';
import { serviceDefinition } from '../dist/service.js';

const { values } = parseArgs({ options: { 'release-dir': { type: 'string' }, 'bootstrap-node': { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/native-smoke.mjs --release-dir /absolute/packaged-release-directory [--bootstrap-node]\nRun as a normal logged-in macOS/Linux user with an active launchd/systemd user manager.\n--bootstrap-node restricts only the installer PATH to /usr/bin:/bin:/usr/sbin:/sbin and requires that PATH to contain no Node.js 24. It verifies an actual downloaded private Node.js 24.22.1 runtime.');
  process.exit(0);
}
const started = Date.now();
const bootstrapNode = Boolean(values['bootstrap-node']);
const bootstrapPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const workBudget = bootstrapNode ? 110_000 : 70_000;
let step = 'preflight';
let directory, hub, definition, dataDir, installDir, jobId, serviceAttempted = false;
let cleaning = false, interrupted = false;
const children = new Set();
const captured = [];
const secrets = new Set();
const report = { ok: false, platform: process.platform, arch: process.arch, node: process.version };
if (bootstrapNode) Object.assign(report, { bootstrapNode: true, downloadedRuntime: false });
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function budget(requested) {
  if (interrupted && !cleaning) throw Error('Smoke check interrupted');
  const remaining = started + workBudget + (cleaning ? 20_000 : 0) - Date.now();
  if (remaining <= 0) throw Error('Smoke check deadline exceeded');
  return Math.min(requested, remaining);
}
function stop(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* Already exited. */ } }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  for (const child of children) stop(child, 'SIGTERM');
});
async function run(executable, args, maximum = 20_000, commandPath) {
  const timeout = budget(maximum);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: commandPath ?? `${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      detached: true,
    });
    children.add(child);
    let stdout = '', stderr = '', timedOut = false, forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child, 'SIGTERM');
      forceTimer = setTimeout(() => stop(child, 'SIGKILL'), 1000);
    }, timeout);
    const collect = target => chunk => {
      if (target === 'stdout') stdout += String(chunk);
      else stderr += String(chunk);
      if (stdout.length + stderr.length > 1024 * 1024) stop(child, 'SIGTERM');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', error => {
      clearTimeout(timer); clearTimeout(forceTimer); children.delete(child);
      reject(Error(`Cannot start smoke subprocess: ${error.code ?? 'unknown error'}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(forceTimer); children.delete(child);
      captured.push(stdout, stderr);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}
function successful(result, action) {
  if (result.code !== 0 || result.timedOut) throw Error(`${action} failed (${result.timedOut ? 'timeout' : `exit ${result.code ?? result.signal}`})`);
  return result;
}
async function until(check, milliseconds, description) {
  const deadline = Date.now() + budget(milliseconds);
  do {
    const result = await check();
    if (result) return result;
    if (interrupted && !cleaning) throw Error('Smoke check interrupted');
    await pause(200);
  } while (Date.now() < deadline);
  throw Error(`Timed out waiting for ${description}`);
}
async function nativeState() {
  if (process.platform === 'darwin') {
    const result = await run('launchctl', ['print', `gui/${process.getuid()}/${definition.label}`], 5000);
    const pid = Number(result.stdout.match(/^\s*pid = (\d+)$/m)?.[1] ?? 0);
    return { loaded: result.code === 0, active: result.code === 0 && pid > 0, pid };
  }
  const result = await run('systemctl', ['--user', 'show', '--property=LoadState,ActiveState,MainPID', definition.label], 5000);
  if (!/^LoadState=/m.test(result.stdout)) throw Error('systemd user manager is unavailable');
  return {
    loaded: !/^LoadState=not-found$/m.test(result.stdout),
    active: /^ActiveState=(?:active|activating|deactivating)$/m.test(result.stdout),
    pid: Number(result.stdout.match(/^MainPID=(\d+)$/m)?.[1] ?? 0),
  };
}
async function verifyNoCredentialsPrinted() {
  if (dataDir && await exists(path.join(dataDir, 'config.json'))) {
    const config = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
    if (typeof config.token === 'string') secrets.add(config.token);
  }
  for (const secret of secrets) if (secret && captured.some(text => text.includes(secret))) throw Error('A credential appeared in subprocess output (output withheld)');
}

try {
  if (!['darwin', 'linux'].includes(process.platform)) throw Error('Native smoke supports macOS and Linux only');
  if (process.getuid() === 0) throw Error('Run native smoke as a normal user, without sudo');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Use existing Node.js 24 for this smoke check');
  const releaseDir = path.resolve(values['release-dir'] ?? fileURLToPath(new URL('../releases', import.meta.url)));
  for (const name of ['install.sh', 'comand-agent.tar.gz', 'comand-agent.tar.gz.sha256']) {
    if (!(await lstat(path.join(releaseDir, name))).isFile()) throw Error('Release files must be regular files');
  }
  if (bootstrapNode) {
    const probe = successful(await run('/bin/sh', ['-c', 'if command -v node >/dev/null 2>&1; then node -p \'process.versions.node.split(".")[0]\'; else printf "absent\\n"; fi'], 5000, bootstrapPath), 'Restricted PATH Node preflight');
    const major = probe.stdout.trim();
    if (major !== 'absent' && !/^\d+$/.test(major)) throw Error('Cannot establish the Node.js version on the restricted installer PATH');
    if (major === '24') throw Error('Restricted installer PATH already contains Node.js 24; bootstrap coverage requires a host without system Node.js 24');
    report.restrictedPathNode = major === 'absent' ? 'absent' : `major ${major}`;
  }
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'comand-native-smoke-')));
  dataDir = path.join(directory, 'agent state with spaces');
  installDir = path.join(directory, 'program with spaces');
  const workspace = path.join(directory, 'workspace with spaces');
  await mkdir(workspace, { mode: 0o700 });
  definition = serviceDefinition('agent', dataDir);
  if (await exists(definition.path) || (await nativeState()).loaded) throw Error('Temporary service label already exists; no service changed');
  const owner = randomBytes(32).toString('hex');
  secrets.add(owner);
  hub = await createHub({ dataDir: path.join(directory, 'hub'), adminToken: owner, host: '127.0.0.1', port: 0, distributionDir: releaseDir, webDir: path.join(directory, 'no-web') });
  const origin = await hub.start();
  const code = hub.store.createPairing().code;
  secrets.add(code);
  step = 'native-install';
  serviceAttempted = true;
  const installation = await run('bash', [path.join(releaseDir, 'install.sh'), '--url', origin, '--code', code, '--name', 'Native service smoke', '--root', workspace, '--data-dir', dataDir, '--install-dir', installDir, '--allow-shell'], bootstrapNode ? 85_000 : 45_000, bootstrapNode ? bootstrapPath : undefined);
  successful(installation, 'Native installer');
  await verifyNoCredentialsPrinted();
  if (bootstrapNode) {
    const runtime = await realpath(path.join(installDir, 'node'));
    if (!runtime.startsWith(path.join(installDir, 'runtimes') + path.sep)) throw Error('Installer used a system runtime; no Node bootstrap was verified');
    const runtimeVersion = successful(await run(path.join(installDir, 'node'), ['--version'], 5000), 'Downloaded Node version').stdout.trim();
    if (runtimeVersion !== 'v24.22.1') throw Error('Downloaded runtime version is not Node.js 24.22.1');
    Object.assign(report, { downloadedRuntime: true, downloadedNodeVersion: runtimeVersion });
  }
  const config = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
  if (((await lstat(path.join(dataDir, 'config.json'))).mode & 0o777) !== 0o600) throw Error('Credential file permissions are not 0600');
  step = 'device-poll';
  const device = await until(() => {
    const value = hub.store.getDevice(config.deviceId);
    return value?.online && value.lastSeenAt ? value : null;
  }, 15_000, 'native service device poll');
  step = 'service-status';
  const wrapper = path.join(installDir, 'bin', 'comand');
  successful(await run(wrapper, ['service', 'status', '--kind', 'agent', '--data-dir', dataDir]), 'Native service status');
  const manager = await nativeState();
  const daemon = JSON.parse(await readFile(path.join(dataDir, 'daemon.json'), 'utf8'));
  if (!manager.active || manager.pid !== daemon.pid || !alive(daemon.pid)) throw Error('Native manager PID does not match the installed agent');
  step = 'command-job';
  const project = hub.store.createProject({ deviceId: config.deviceId, name: 'Native smoke', root: config.roots[0] });
  const job = hub.store.createJob({ projectId: project.id, idempotencyKey: 'native-service-smoke', operation: { kind: 'command', command: "printf 'native-service-smoke\\n'", timeoutMs: 10_000 } });
  jobId = job.id;
  const result = await until(() => {
    const current = hub.store.getJob(job.id);
    return ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(current.status) ? current : null;
  }, 15_000, 'native service command completion');
  if (result.status !== 'succeeded' || result.exitCode !== 0) throw Error(`Smoke command ended as ${result.status}`);
  const logs = hub.store.getLogs(job.id, 0, 65536);
  if (logs.text !== 'native-service-smoke\n') throw Error('Smoke command output does not match');
  await verifyNoCredentialsPrinted();
  Object.assign(report, { ok: true, version: device.version, devicePolled: true, job: result.status, exitCode: result.exitCode, output: logs.text.trim(), service: { manager: process.platform === 'darwin' ? 'launchd' : 'systemd-user', active: true, pidMatched: true }, credentialsPrinted: false, credentialsMode: '0600' });
} catch (error) {
  report.ok = false;
  report.step = step;
  report.error = error.message;
} finally {
  cleaning = true;
  let safeToRemove = true;
  try {
    if (hub && jobId) {
      const job = hub.store.getJob(jobId);
      if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        hub.store.cancelJob(jobId);
        await until(() => ['succeeded', 'failed', 'cancelled'].includes(hub.store.getJob(jobId).status), 10_000, 'smoke job cancellation');
      }
    }
  } catch { safeToRemove = false; }
  try {
    if (serviceAttempted) {
      const wrapper = path.join(installDir, 'bin', 'comand');
      if (await exists(wrapper)) successful(await run(wrapper, ['service', 'uninstall', '--kind', 'agent', '--data-dir', dataDir], 10_000), 'Temporary service uninstall');
      else if (await exists(path.join(installDir, 'current', 'dist', 'cli.js')))
        successful(await run(path.join(installDir, 'node'), [path.join(installDir, 'current', 'dist', 'cli.js'), 'service', 'uninstall', '--kind', 'agent', '--data-dir', dataDir], 10_000), 'Temporary service uninstall');
      await until(async () => {
        const manager = await nativeState();
        let pid = 0;
        try { pid = JSON.parse(await readFile(path.join(dataDir, 'daemon.json'), 'utf8')).pid; } catch { /* Agent removed its daemon marker. */ }
        return !manager.active && manager.pid === 0 && !(await exists(definition.path)) && (!pid || !alive(pid));
      }, 8000, 'temporary native service stop');
      report.serviceRemoved = true;
    }
    await verifyNoCredentialsPrinted();
  } catch (error) {
    safeToRemove = false;
    report.ok = false;
    report.cleanupError = error.message;
  }
  if (hub) await hub.close().catch(() => { safeToRemove = false; report.ok = false; report.cleanupError = 'Temporary hub did not close'; });
  if (directory && safeToRemove) {
    await rm(directory, { recursive: true, force: true }).catch(() => { safeToRemove = false; report.ok = false; });
  }
  report.temporaryStateRemoved = Boolean(directory && safeToRemove);
  if (directory && !safeToRemove) { report.ok = false; report.retainedDirectory = directory; }
  report.elapsedMs = Date.now() - started;
  // No captured subprocess output, config, pairing code or owner token is emitted.
  let output = JSON.stringify(report, null, 2);
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[redacted]');
  console.log(output);
  if (!report.ok) process.exitCode = 1;
}
