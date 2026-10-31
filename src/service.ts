import { mkdirSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
const unitQuote = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
function execute(command: string, args: string[], tolerateFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  if (result.error || result.status !== 0) {
    if (!tolerateFailure)
      throw Error(
        `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`,
      );
  }
  return result;
}

export function serviceDefinition(
  kind: 'hub' | 'agent',
  dataDir: string,
  platform = process.platform,
): { label: string; path: string; content: string } {
  if (/[\r\n\0]/.test(dataDir)) throw Error('Invalid state directory');
  const id = createHash('sha256').update(dataDir).digest('hex').slice(0, 8);
  const label = `world.imon.comand.${kind}.${id}`;
  const built = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') ? '../dist/' : './', import.meta.url),
  );
  const cli = join(built, kind === 'hub' ? 'cli.js' : 'agent/cli.js');
  const args = [process.execPath, cli, kind === 'hub' ? 'hub' : 'run', '--data-dir', dataDir];
  const environment: Record<string, string> = {
    NODE_ENV: 'production',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
  if (kind === 'agent' && process.env.COMAND_BROWSER_CHANNEL) {
    const channel = process.env.COMAND_BROWSER_CHANNEL;
    if (!['chrome', 'chromium'].includes(channel))
      throw Error('COMAND_BROWSER_CHANNEL must be chrome or chromium.');
    environment.COMAND_BROWSER_CHANNEL = channel;
  }
  const launchEnvironment = Object.entries(environment)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join('');
  const unitEnvironment = Object.entries(environment)
    .map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`)
    .join('\n');
  if (platform === 'darwin') {
    const servicePath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(resolve(built, '..'))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${xml(join(dataDir, 'service.stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(dataDir, 'service.stderr.log'))}</string><key>EnvironmentVariables</key><dict>${launchEnvironment}</dict></dict></plist>\n`;
    return { label, path: servicePath, content };
  }
  if (platform !== 'linux') throw Error('Automatic service installation supports macOS and Linux');
  const name = `comand-${kind}-${id}.service`;
  const content = `[Unit]\nDescription=Comand ${kind}\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${unitQuote(resolve(built, '..'))}\nExecStart=${args.map(unitQuote).join(' ')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nKillMode=${kind === 'agent' ? 'process' : 'mixed'}\nUMask=0077\n${unitEnvironment}\n\n[Install]\nWantedBy=default.target\n`;
  return { label: name, path: join(homedir(), '.config', 'systemd', 'user', name), content };
}

export function serviceCli(args: string[]): void {
  const [action = 'help', ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      kind: { type: 'string', default: 'hub' },
      'data-dir': { type: 'string' },
      print: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!['hub', 'agent'].includes(values.kind!)) throw Error('--kind must be hub or agent');
  if (!['install', 'uninstall', 'status', 'restart'].includes(action)) {
    console.log(
      'comand service install|status|restart|uninstall --kind hub|agent --data-dir PATH [--print]',
    );
    return;
  }
  const kind = values.kind as 'hub' | 'agent';
  const dataDir = resolve(
    values['data-dir'] ??
      (kind === 'hub' ? process.env.COMAND_DATA_DIR : undefined) ??
      join(homedir(), '.comand', kind),
  );
  const definition = serviceDefinition(kind, dataDir);
  if (values.print) {
    console.log(definition.content);
    return;
  }
  const target = `gui/${process.getuid!()}`;
  if (action === 'install') {
    if (!existsSync(join(dataDir, kind === 'hub' ? 'hub.json' : 'config.json')))
      throw Error(`Initialize/pair ${kind} first. Missing configuration in ${dataDir}`);
    mkdirSync(resolve(definition.path, '..'), { recursive: true, mode: 0o700 });
    for (const file of ['service.stdout.log', 'service.stderr.log']) {
      const path = join(dataDir, file);
      if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    if (process.platform === 'darwin')
      execute('launchctl', ['bootout', `${target}/${definition.label}`], true);
    writeFileSync(definition.path, definition.content, { mode: 0o600 });
    if (process.platform === 'darwin') execute('launchctl', ['bootstrap', target, definition.path]);
    else {
      execute('systemctl', ['--user', 'daemon-reload']);
      execute('systemctl', ['--user', 'enable', '--now', definition.label]);
    }
    console.log(`Installed ${definition.label}\nConfiguration: ${definition.path}`);
  } else if (action === 'uninstall') {
    if (process.platform === 'darwin')
      execute('launchctl', ['bootout', `${target}/${definition.label}`], true);
    else execute('systemctl', ['--user', 'disable', '--now', definition.label], true);
    if (existsSync(definition.path)) unlinkSync(definition.path);
    if (process.platform === 'linux') execute('systemctl', ['--user', 'daemon-reload']);
    console.log('Service removed. Configuration, credentials and job evidence were retained.');
  } else if (action === 'restart') {
    if (process.platform === 'darwin')
      execute('launchctl', ['kickstart', '-k', `${target}/${definition.label}`]);
    else execute('systemctl', ['--user', 'restart', definition.label]);
    console.log(`Restarted ${definition.label}`);
  } else {
    const result =
      process.platform === 'darwin'
        ? execute('launchctl', ['print', `${target}/${definition.label}`], true)
        : execute('systemctl', ['--user', 'status', '--no-pager', definition.label], true);
    console.log(result.stdout || result.stderr);
    if (result.status) process.exitCode = result.status;
  }
}
