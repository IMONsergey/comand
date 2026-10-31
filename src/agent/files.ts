import { constants } from 'node:fs';
import {
  lstat,
  realpath,
  readdir,
  readFile,
  mkdir,
  rename,
  open,
  unlink,
  link,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_FILE_BYTES, type Operation } from '../shared/protocol.js';
export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep);
export async function projectRoot(root: string, approved: string[]) {
  const actual = await realpath(root);
  const roots = await Promise.all(approved.map((r) => realpath(r)));
  if (!roots.some((r) => within(r, actual))) throw Error('Project path is outside approved roots');
  return actual;
}
export async function safePath(root: string, input: string, mutation = false): Promise<string> {
  if (path.isAbsolute(input) || input.split(/[\\/]/).includes('..') || input.includes('\0'))
    throw Error('Path must be relative and cannot traverse outside the project');
  const target = path.resolve(root, input);
  if (!within(root, target)) throw Error('Path outside project');
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const st = await lstat(cursor);
      if (mutation && st.isSymbolicLink()) throw Error('Symlink mutation is forbidden');
      const actual = await realpath(cursor);
      if (!within(root, actual)) throw Error('Symlink path leaves project');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!mutation) throw e;
        break;
      }
      throw e;
    }
  }
  return target;
}
async function textFile(p: string) {
  const handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw Error('Not a regular file');
    if (st.size > MAX_FILE_BYTES) throw Error(`File exceeds ${MAX_FILE_BYTES} byte limit`);
    const data = await handle.readFile();
    if (data.length > MAX_FILE_BYTES) throw Error('File exceeds size limit');
    if (data.includes(0)) throw Error('Binary files are not supported');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw Error('Binary or non-UTF-8 files are not supported');
    }
    return data;
  } finally {
    await handle.close();
  }
}
export async function executeFileOperation(
  operation: Operation,
  rootInput: string,
  approved: string[],
): Promise<unknown> {
  const root = await projectRoot(rootInput, approved);
  if (operation.kind === 'files.list') {
    const p = await safePath(root, operation.path);
    const entries = await readdir(p, { withFileTypes: true });
    return {
      path: operation.path,
      entries: entries.slice(0, 1000).map((e) => ({
        name: e.name,
        type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file',
      })),
      truncated: entries.length > 1000,
    };
  }
  if (operation.kind === 'files.read') {
    const p = await safePath(root, operation.path);
    const data = await textFile(await realpath(p));
    const end = Math.min(data.length, operation.offset + operation.limit);
    return {
      path: operation.path,
      content: data.subarray(operation.offset, end).toString('utf8'),
      hash: hash(data),
      offset: operation.offset,
      nextOffset: end,
      size: data.length,
      truncated: end < data.length,
    };
  }
  if (operation.kind === 'files.write') {
    const p = await safePath(root, operation.path, true);
    if (p === root) throw Error('Cannot replace project root');
    const content = Buffer.from(operation.content);
    if (content.length > MAX_FILE_BYTES || content.includes(0))
      throw Error('Binary or overlarge content is not supported');
    const check = async () => {
      try {
        await lstat(p);
        if (operation.createOnly) throw Error('File already exists (createOnly conflict)');
        const old = await textFile(p);
        if (operation.expectedHash && hash(old) !== operation.expectedHash)
          throw Error('File hash conflict');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        if (operation.expectedHash) throw Error('File hash conflict: file does not exist');
      }
    };
    await check();
    const temp = path.join(path.dirname(p), `.comand-${randomUUID()}.tmp`);
    const h = await open(temp, 'wx', 0o600);
    try {
      await h.writeFile(content);
      await h.sync();
    } finally {
      await h.close();
    }
    try {
      await safePath(root, operation.path, true);
      await check();
      if (operation.createOnly) {
        await link(temp, p);
        await unlink(temp);
      } else await rename(temp, p);
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
    return { path: operation.path, bytes: content.length, hash: hash(content) };
  }
  if (operation.kind === 'files.mkdir') {
    const p = await safePath(root, operation.path, true);
    await mkdir(p, { recursive: true });
    return { path: operation.path };
  }
  if (operation.kind === 'files.move') {
    const from = await safePath(root, operation.from, true);
    const to = await safePath(root, operation.to, true);
    if (from === root || to === root) throw Error('Cannot move project root');
    if (!(await lstat(from)).isFile())
      throw Error(
        'files.move supports regular files only. Directory moves require an authorized shell command.',
      );
    // link creates the destination atomically with no replacement, including concurrent moves.
    try {
      await link(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw Error('Destination already exists');
      if (code === 'EXDEV')
        throw Error(
          'Cross-filesystem file moves are unsupported. Use an authorized shell command to copy and remove the source.',
        );
      throw e;
    }
    try {
      if (!(await lstat(to)).isFile()) throw Error('Source changed during move');
      await unlink(from);
    } catch (e) {
      await unlink(to).catch(() => {});
      throw e;
    }
    return { from: operation.from, to: operation.to };
  }
  if (operation.kind === 'files.search') {
    const start = await safePath(root, operation.path);
    const results: Array<{ path: string; line: number; text: string }> = [];
    let visited = 0,
      truncated = false;
    const walk = async (p: string): Promise<void> => {
      if (results.length >= operation.maxResults || visited >= 2000) {
        truncated = true;
        return;
      }
      visited++;
      const st = await lstat(p);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        for (const e of await readdir(p, { withFileTypes: true })) {
          if (e.isSymbolicLink()) continue;
          await walk(path.join(p, e.name));
          if (truncated) break;
        }
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        let data: Buffer;
        try {
          data = await textFile(p);
        } catch {
          return;
        }
        for (const [index, line] of data.toString('utf8').split('\n').entries()) {
          if (line.includes(operation.query)) {
            results.push({
              path: path.relative(root, p),
              line: index + 1,
              text: line.slice(0, 2000),
            });
            if (results.length >= operation.maxResults) {
              truncated = true;
              break;
            }
          }
        }
      }
    };
    await walk(start);
    return { results, truncated, filesVisited: visited };
  }
  throw Error(`Unsupported file operation ${operation.kind}`);
}
