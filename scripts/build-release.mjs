#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { parseArgs } from 'node:util';

// USTAR metadata and gzip mtime are fixed. Identical inputs on the same Node/zlib
// version produce byte-identical archives regardless of filesystem timestamps.
export async function deterministicArchive(source, destination) {
  async function* entries(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.bin') continue; // npm executable links are not used at runtime.
      if (/[\r\n\0]/.test(name)) throw Error('Unsupported archive filename');
      const local = path.join(directory, name);
      const stat = await lstat(local);
      if (!stat.isFile() && !stat.isDirectory()) throw Error(`Unsupported archive entry: ${prefix}/${name}`);
      const archivePath = `${prefix}/${name}${stat.isDirectory() ? '/' : ''}`;
      const header = Buffer.alloc(512);
      let basename = archivePath;
      let parent = '';
      if (Buffer.byteLength(basename) > 100) {
        const split = archivePath.lastIndexOf('/', archivePath.length - 2);
        basename = archivePath.slice(split + 1);
        parent = archivePath.slice(0, split);
      }
      if (Buffer.byteLength(basename) > 100 || Buffer.byteLength(parent) > 155)
        throw Error(`Archive path exceeds USTAR limits: ${archivePath}`);
      header.write(basename, 0, 100);
      const octal = (number, offset, length) => header.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length);
      octal(stat.isDirectory() ? 0o755 : stat.mode & 0o111 ? 0o755 : 0o644, 100, 8);
      octal(0, 108, 8);
      octal(0, 116, 8);
      octal(stat.isFile() ? stat.size : 0, 124, 12);
      octal(0, 136, 12);
      header.fill(32, 148, 156);
      header.write(stat.isDirectory() ? '5' : '0', 156, 1);
      header.write('ustar\0', 257, 6);
      header.write('00', 263, 2);
      header.write(parent, 345, 155);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
      yield header;
      if (stat.isDirectory()) yield* entries(local, archivePath.slice(0, -1));
      else {
        yield* createReadStream(local);
        if (stat.size % 512) yield Buffer.alloc(512 - (stat.size % 512));
      }
    }
  }
  async function* archive() {
    yield* entries(source, 'comand-agent');
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(archive()), createGzip({ level: 9 }), createWriteStream(destination));
}

export async function buildRelease({ root, out, offline = false }) {
  root = path.resolve(root);
  out = path.resolve(out);
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Build releases with Node.js 24.');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw Error('Invalid release version');
  if (pkg.version !== lock.version || lock.packages[''].version !== pkg.version)
    throw Error('package.json and lockfile versions differ');
  await lstat(path.join(root, 'dist', 'agent', 'cli.js'));
  const temp = await mkdtemp(path.join(tmpdir(), 'comand-release-'));
  try {
    const stage = path.join(temp, 'package');
    await mkdir(stage);
    await cp(path.join(root, 'package.json'), path.join(stage, 'package.json'));
    await cp(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
    const installed = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], {
      cwd: stage, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    });
    if (installed.status !== 0) throw Error('Production dependency installation failed');
    await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
    const release = { name: 'comand-agent', version: pkg.version, nodeMajor: 24, format: 1 };
    await writeFile(path.join(stage, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    const checked = spawnSync(process.execPath, [path.join(stage, 'dist', 'cli.js'), 'version'], { encoding: 'utf8' });
    if (checked.status !== 0 || checked.stdout.trim() !== pkg.version)
      throw Error(`Built CLI version does not match package.json; rebuild first. ${checked.stderr}`);
    const filename = `comand-agent-${pkg.version}.tar.gz`;
    const archive = path.join(temp, filename);
    await deterministicArchive(stage, archive);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const digest = hash.digest('hex');
    await mkdir(out, { recursive: true });
    // Each file is replaced atomically. Deploy the whole directory atomically to
    // avoid clients observing the old checksum beside the new archive.
    for (const [name, value] of [
      [filename, await readFile(archive)],
      [`${filename}.sha256`, `${digest}  ${filename}\n`],
      ['comand-agent.tar.gz', await readFile(archive)],
      ['comand-agent.tar.gz.sha256', `${digest}  comand-agent.tar.gz\n`],
      ['install.sh', await readFile(path.join(root, 'scripts', 'install.sh'))],
    ]) {
      await writeFile(path.join(out, `.${name}.tmp`), value, { mode: 0o644 });
      await rename(path.join(out, `.${name}.tmp`), path.join(out, name));
    }
    console.log(`Release ${pkg.version}: ${filename}\nSHA256 ${digest}\nOutput ${out}`);
    return { version: pkg.version, digest, filename };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, offline: { type: 'boolean' } } });
  const root = fileURLToPath(new URL('../', import.meta.url));
  buildRelease({ root, out: values.out ?? path.join(root, 'releases'), offline: values.offline }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
