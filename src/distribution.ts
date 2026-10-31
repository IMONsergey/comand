import type { Express } from 'express';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DistributionOptions {
  /** A dedicated release directory, never the hub or agent state directory. */
  directory?: string;
}

/** Register before the web application's catch-all. No directory is exposed. */
export function installDistribution(app: Express, options: DistributionOptions = {}): void {
  const directory = resolve(
    options.directory ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'releases'),
  );
  const files = [
    ['/install.sh', 'install.sh', 'text/x-shellscript; charset=utf-8'],
    ['/downloads/comand-agent.tar.gz', 'comand-agent.tar.gz', 'application/gzip'],
    ['/downloads/comand-agent.tar.gz.sha256', 'comand-agent.tar.gz.sha256', 'text/plain; charset=utf-8'],
  ] as const;
  for (const [route, name, contentType] of files) {
    app.get(route, async (_req, res, next) => {
      const file = join(directory, name);
      try {
        // A packaged regular file is required; symlinks cannot point into state.
        const info = await lstat(file);
        if (!info.isFile() || (await realpath(file)) !== join(await realpath(directory), name))
          throw Error('Not a packaged regular file');
        res.set({
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename="${name}"`,
        });
        res.sendFile(file, { dotfiles: 'deny', acceptRanges: true }, (error) => {
          if (error) next(error);
        });
      } catch {
        res.status(503).set('Cache-Control', 'no-store').json({
          error: 'Установщик пока недоступен. Администратору нужно опубликовать сборку агента.',
          code: 'distribution_unavailable',
        });
      }
    });
  }
  // Unknown download paths must not fall through to the SPA or filesystem.
  app.use('/downloads', (_req, res) => res.status(404).json({ error: 'Not found' }));
}
