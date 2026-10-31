import { spawn } from 'node:child_process';
import { open, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, type Acceptance, type LocalStatus } from './state.js';
import { executeFileOperation, projectRoot } from './files.js';
import { launchInspectionBrowser } from './browser.js';
import { executeProcessOperation, ProcessUncertainError } from './processes.js';
const MAX_LOG = 10 * 1024 * 1024;
const MARKER = Buffer.from('\n[comand: log truncated at 10 MiB]\n');
export async function supervise(dir: string) {
  // Claim is never deleted: even a duplicated supervisor cannot execute twice.
  const claim = await open(path.join(dir, 'supervisor.claim'), 'wx', 0o600).catch(() => null);
  if (!claim) return;
  await claim.writeFile(String(process.pid));
  await claim.sync();
  await claim.close();
  const accepted = await readJson<Acceptance>(path.join(dir, 'accepted.json'));
  const { job, project } = accepted.dispatch;
  let status: LocalStatus = {
    jobId: job.id,
    status: 'running',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
  };
  const persist = () => atomicJson(path.join(dir, 'status.json'), status);
  await persist();
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    status.heartbeat = new Date().toISOString();
    persist()
      .finally(() => (heartbeatBusy = false))
      .catch(() => {});
  }, 1000);
  heartbeat.unref();
  const cancelled = async () =>
    access(path.join(dir, 'cancel')).then(
      () => true,
      () => false,
    );
  const log = await open(path.join(dir, 'output.log'), 'a', 0o600);
  let bytes = (await log.stat()).size,
    truncated = bytes >= MAX_LOG;
  let writing = Promise.resolve();
  const append = (chunk: Buffer) => {
    writing = writing.then(async () => {
      if (truncated) return;
      const room = MAX_LOG - MARKER.length - bytes;
      const data = chunk.subarray(0, Math.max(0, room));
      if (data.length) {
        await log.write(data);
        bytes += data.length;
      }
      if (chunk.length > room) {
        await log.write(MARKER);
        bytes += MARKER.length;
        truncated = true;
      }
    });
  };
  try {
    if (await cancelled()) {
      status.status = 'cancelled';
    } else {
      const root = await projectRoot(project.root, accepted.config.roots);
      const op = job.operation;
      if (op.kind === 'command') {
        if (!accepted.config.allowShell)
          throw Error(
            'Shell commands are disabled. Pair this device with --allow-shell to enable trusted-owner shell execution.',
          );
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const child = spawn('/bin/sh', ['-c', op.command], {
          cwd: root,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        status.processGroup = child.pid;
        child.stdout.on('data', (chunk: Buffer) => append(chunk));
        child.stderr.on('data', (chunk: Buffer) => append(chunk));
        let ended = false,
          requested = false,
          timedOut = false,
          killTimer: NodeJS.Timeout | undefined;
        const kill = (signal: NodeJS.Signals) => {
          if (child.pid)
            try {
              process.kill(-child.pid, signal);
            } catch {}
        };
        const stop = () => {
          if (ended || requested) return;
          requested = true;
          kill('SIGTERM');
          killTimer = setTimeout(() => kill('SIGKILL'), 1500);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, op.timeoutMs);
        const cancellation = setInterval(() => {
          void cancelled().then((yes) => {
            if (yes) stop();
          });
        }, 100);
        const exiting = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => {
              ended = true;
              resolve({ code, signal });
            });
          },
        ).finally(() => {
          clearTimeout(timer);
          clearInterval(cancellation);
          if (killTimer) clearTimeout(killTimer);
          kill('SIGKILL');
        });
        await persist();
        const exit = await exiting;
        status.exitCode = exit.code;
        // A proven successful exit wins a late cancellation race.
        status.status =
          exit.code === 0 ? 'succeeded' : timedOut ? 'failed' : requested ? 'cancelled' : 'failed';
        if (timedOut) status.error = `Command exceeded timeout (${op.timeoutMs} ms)`;
        else if (status.status === 'failed')
          status.error = `Command exited with ${exit.code ?? exit.signal}`;
      } else if (op.kind.startsWith('process.')) {
        status.result = await executeProcessOperation(dir, accepted, root);
        status.status = 'succeeded';
      } else if (op.kind === 'browser.inspect') {
        if (!accepted.config.allowBrowser)
          throw Error('Browser inspection is disabled. Pair with --allow-browser to enable it.');
        const url = new URL(op.url);
        if (!['http:', 'https:'].includes(url.protocol))
          throw Error('Browser inspection requires an HTTP or HTTPS URL');
        let browser: import('playwright').Browser | undefined;
        let browserCancelled = false;
        const browserCancellation = setInterval(() => {
          void cancelled().then((yes) => {
            if (yes) {
              browserCancelled = true;
              void browser?.close();
            }
          });
        }, 100);
        try {
          const { chromium } = await import('playwright');
          browser = await launchInspectionBrowser(chromium);
          if (browserCancelled) throw Error('Browser cancelled');
          const context = await browser.newContext({
            viewport: { width: op.width, height: op.height },
            acceptDownloads: false,
          });
          const page = await context.newPage();
          await page.goto(op.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const text = (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 50000);
          let screenshot: string | undefined;
          if (op.screenshot) {
            const image = await page.screenshot({
              type: 'jpeg',
              quality: 65,
              fullPage: false,
              timeout: 10000,
            });
            if (image.length > 1024 * 1024) throw Error('Screenshot exceeds 1 MiB limit');
            screenshot = image.toString('base64');
          }
          status.result = {
            url: page.url(),
            title: await page.title(),
            text,
            screenshot,
            screenshotMime: screenshot ? 'image/jpeg' : undefined,
          };
          status.status = 'succeeded';
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (browserCancelled) {
            status.status = 'cancelled';
          } else
            throw Error(
              message.includes('Cannot find package') || message.includes('Cannot find module')
                ? `Browser dependency unavailable. Install project dependencies and run npx playwright install chromium. ${message}`
                : message,
            );
        } finally {
          clearInterval(browserCancellation);
          await browser?.close();
        }
      } else {
        status.result = await executeFileOperation(op, root, accepted.config.roots);
        status.status = 'succeeded';
      }
    }
  } catch (e) {
    status.status = e instanceof ProcessUncertainError ? 'uncertain' : 'failed';
    status.error = e instanceof Error ? e.message : String(e);
  } finally {
    clearInterval(heartbeat);
    while (heartbeatBusy) await new Promise((r) => setTimeout(r, 10));
    await writing;
    await log.sync();
    await log.close();
    status.finishedAt = new Date().toISOString();
    status.heartbeat = new Date().toISOString();
    await persist();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) throw Error('Missing supervisor state directory');
  await supervise(dir);
}
