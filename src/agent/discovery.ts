import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Discovery, DiscoveryResult } from '../shared/discovery.js';

const markers = new Set([
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'CMakeLists.txt',
  'pom.xml',
  'build.gradle',
  'index.html',
  'README.md',
  'AGENTS.md',
]);
const skipped = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  'Library',
  'Applications',
  'Caches',
]);
const within = (root: string, value: string) =>
  value === root || value.startsWith(root === '/' ? '/' : root + path.sep);

/** Metadata only. No shell, file contents, writes, symlink traversal or background indexing. */
export async function discoverProjects(
  request: Pick<Discovery, 'query' | 'path'>,
  approved: string[],
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    roots: [],
    candidates: [],
    visited: 0,
    truncated: false,
    warnings: [],
  };
  for (const root of approved) {
    try {
      result.roots.push(await realpath(root));
    } catch {
      if (result.warnings.length < 32) result.warnings.push(`Недоступна папка: ${root}`);
    }
  }
  result.roots = [...new Set(result.roots)];
  let starts = result.roots;
  if (request.path) {
    if (!path.isAbsolute(request.path) || request.path.includes('\0'))
      throw Error('Нужен абсолютный путь');
    const selected = await realpath(request.path);
    if (!result.roots.some((root) => within(root, selected)))
      throw Error('Папка вне разрешённой области поиска');
    if ((await lstat(request.path)).isSymbolicLink())
      throw Error('Выберите исходную папку, а не символическую ссылку');
    starts = [selected];
  }
  const queue = starts.map((root) => ({ root, depth: 0 }));
  const seen = new Set<string>();
  const deadline = Date.now() + 4000;
  const query = request.query.toLocaleLowerCase();
  let entriesRead = 0;
  while (queue.length) {
    if (
      Date.now() >= deadline ||
      result.visited >= 2500 ||
      entriesRead >= 25000 ||
      result.candidates.length >= 100
    ) {
      result.truncated = true;
      break;
    }
    const item = queue.shift()!;
    if (seen.has(item.root)) continue;
    seen.add(item.root);
    try {
      if ((await lstat(item.root)).isSymbolicLink()) continue;
      const canonical = await realpath(item.root);
      if (canonical !== item.root || !result.roots.some((root) => within(root, canonical)))
        continue;
      result.visited++;
      const found: string[] = [];
      const children: string[] = [];
      const directory = await opendir(canonical);
      for await (const entry of directory) {
        if (++entriesRead > 25000 || Date.now() >= deadline) {
          result.truncated = true;
          break;
        }
        if (entry.isSymbolicLink()) continue;
        if (markers.has(entry.name)) found.push(entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && !skipped.has(entry.name))
          children.push(path.join(canonical, entry.name));
      }
      const name = path.basename(canonical) || canonical;
      const matches =
        !query ||
        name.toLocaleLowerCase().includes(query) ||
        canonical.toLocaleLowerCase().includes(query);
      if (matches && (found.length || query))
        result.candidates.push({
          root: canonical,
          name: name.slice(0, 200),
          markers: found.sort(),
        });
      // Repositories may contain nested workspaces; inspect them too, within a fixed depth budget.
      if (item.depth < 4)
        for (const root of children.sort()) queue.push({ root, depth: item.depth + 1 });
      else if (children.length) result.truncated = true;
    } catch {
      if (result.warnings.length < 32)
        result.warnings.push(`Не удалось прочитать папку: ${item.root}`);
    }
  }
  result.candidates.sort(
    (a, b) =>
      Number(b.name.toLocaleLowerCase() === query) - Number(a.name.toLocaleLowerCase() === query) ||
      b.markers.length - a.markers.length ||
      a.root.localeCompare(b.root),
  );
  return result;
}
