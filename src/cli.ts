#!/usr/bin/env node
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHub } from './hub/server.js';
import { installMcp } from './mcp/http.js';
import { createMcpServer } from './mcp/tools.js';
import { remoteBackend } from './mcp/client-backend.js';
import { agentCli } from './agent/cli.js';
import { VERSION } from './shared/protocol.js';
import { serviceCli } from './service.js';

interface HubConfig {
  host: string;
  port: number;
  publicUrl?: string;
}
function state(dataDir: string): { config: HubConfig; token: string } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const configPath = join(dataDir, 'hub.json');
  const tokenPath = join(dataDir, 'admin.token');
  if (!existsSync(configPath))
    writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port: 4310 }, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
  if (!existsSync(tokenPath))
    writeFileSync(tokenPath, `${randomBytes(32).toString('base64url')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  chmodSync(tokenPath, 0o600);
  return {
    config: JSON.parse(readFileSync(configPath, 'utf8')) as HubConfig,
    token: readFileSync(tokenPath, 'utf8').trim(),
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command = 'help', ...rest] = args;
  if (command === 'agent') {
    await agentCli(rest);
    return;
  }
  if (command === 'service') {
    serviceCli(rest);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      'data-dir': { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'public-url': { type: 'string' },
      url: { type: 'string' },
      'token-file': { type: 'string' },
      'web-dir': { type: 'string' },
    },
    strict: true,
  });
  const dataDir = resolve(
    values['data-dir'] ?? process.env.COMAND_DATA_DIR ?? join(homedir(), '.comand', 'hub'),
  );
  if (command === 'version') {
    console.log(VERSION);
    return;
  }
  if (command === 'init') {
    const current = state(dataDir);
    if (values.host) current.config.host = values.host;
    if (values.port) current.config.port = Number(values.port);
    if (values['public-url']) current.config.publicUrl = values['public-url'];
    writeFileSync(join(dataDir, 'hub.json'), JSON.stringify(current.config, null, 2), {
      mode: 0o600,
    });
    console.log(
      `Comand initialized. Settings: ${join(dataDir, 'hub.json')}\nOwner key: ${join(dataDir, 'admin.token')}\nStart: comand hub --data-dir ${JSON.stringify(dataDir)}`,
    );
    return;
  }
  if (command === 'token') {
    console.log(state(dataDir).token);
    return;
  }
  if (command === 'mcp') {
    const url = values.url ?? process.env.COMAND_URL ?? 'http://127.0.0.1:4310';
    const tokenPath = values['token-file'] ?? join(dataDir, 'admin.token');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const server = createMcpServer(remoteBackend(url, token));
    await server.connect(new StdioServerTransport());
    const stop = () => {
      void server.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (command === 'hub' || command === 'start') {
    const current = state(dataDir);
    const host = values.host ?? process.env.COMAND_HOST ?? current.config.host;
    const port = Number(values.port ?? process.env.COMAND_PORT ?? current.config.port);
    const publicUrl =
      values['public-url'] ?? process.env.COMAND_PUBLIC_URL ?? current.config.publicUrl;
    const webDir =
      values['web-dir'] ??
      fileURLToPath(
        new URL(import.meta.url.endsWith('.ts') ? '../dist/web' : './web', import.meta.url),
      );
    const hub = await createHub({
      dataDir,
      adminToken: current.token,
      host,
      port,
      publicUrl,
      webDir,
    });
    const url = publicUrl ?? `http://${host === '::1' ? '[::1]' : host}:${port}`;
    const mcp = installMcp(hub, { dataDir, publicUrl: url });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await hub.close();
      mcp.close();
    };
    process.once('SIGINT', () => {
      void stop();
    });
    process.once('SIGTERM', () => {
      void stop();
    });
    await hub.start();
    console.log(
      `Comand ${VERSION} listening at ${url}\nMCP endpoint: ${url}/mcp\nOwner key file: ${join(dataDir, 'admin.token')}\nAgent execution continues independently when this hub stops.`,
    );
    return;
  }
  console.log(
    `Comand ${VERSION}\n\n  comand init [--data-dir DIR]\n  comand hub [--data-dir DIR] [--host 127.0.0.1] [--port 4310] [--public-url https://your-domain]\n  comand token [--data-dir DIR]   Show owner key locally\n  comand mcp [--url URL] [--token-file PATH]   Private stdio MCP bridge\n  comand agent pair|run|status|resolve ...\n\nRequires Node.js 24+. See README.md for setup, device pairing and ChatGPT connection.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
