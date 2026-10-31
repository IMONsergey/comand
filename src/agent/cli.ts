#!/usr/bin/env node
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../shared/shell.js';
import { pairDevice, runAgent, agentStatus, resolveJob, loadConfig, syncJobs } from './index.js';
export async function agentCli(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (['--allow-shell', '--allow-browser', '--acknowledge'].includes(key)) {
      booleans.add(key);
      continue;
    }
    if (!['--url', '--code', '--name', '--root', '--data-dir', '--job'].includes(key))
      throw Error(`Unknown option ${key}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const value = (key: string, fallback?: string) => values.get(key)?.at(-1) ?? fallback;
  const required = (key: string) => {
    const v = value(key);
    if (!v) throw Error(`Required option ${key}`);
    return v;
  };
  const dataDir = path.resolve(value('--data-dir', path.join(homedir(), '.comand', 'agent'))!);
  if (command === 'pair') {
    const config = await pairDevice({
      url: required('--url'),
      code: required('--code'),
      name: required('--name'),
      roots: values.get('--root') ?? [],
      allowShell: booleans.has('--allow-shell'),
      allowBrowser: booleans.has('--allow-browser'),
      dataDir,
    });
    console.log(
      `Paired ${config.name} (${config.deviceId}). Run from this checkout: node dist/agent/cli.js run --data-dir ${shellQuote(dataDir)}`,
    );
    if (config.allowShell)
      console.log(
        'Shell enabled: trusted hub owners can execute commands with this account’s permissions.',
      );
  } else if (command === 'run') {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    console.log('Comand agent running. Accepted jobs continue if the agent stops.');
    await runAgent(dataDir, {
      signal: controller.signal,
      onError: (error) => console.error(`Agent: ${error.message}`),
    });
  } else if (command === 'status') console.log(JSON.stringify(await agentStatus(dataDir), null, 2));
  else if (command === 'resolve') {
    if (!booleans.has('--acknowledge'))
      throw Error(
        'Inspect the uncertain job on this device first; use --acknowledge to accept its unknown outcome and release the lock.',
      );
    console.log(JSON.stringify(await resolveJob(dataDir, required('--job')), null, 2));
    await syncJobs(await loadConfig(dataDir));
  } else
    console.log(
      'Usage: comand-agent pair --url URL --code CODE --name NAME --root PATH [--root PATH] [--allow-shell] [--allow-browser] [--data-dir PATH]\n       comand-agent run|status [--data-dir PATH]\n       comand-agent resolve --job ID --acknowledge [--data-dir PATH]',
    );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))
  agentCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
