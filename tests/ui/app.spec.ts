import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHub, type HubRuntime } from '../../src/hub/server.js';
import { installMcp } from '../../src/mcp/http.js';
import { pairDevice, runAgent } from '../../src/agent/index.js';

let directory: string;
let projectRoot: string;
let hub: HubRuntime;
let url: string;
let token: string;
let runner: Promise<void>;
let controller: AbortController;
let mcp: ReturnType<typeof installMcp>;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comand-ui-'));
  projectRoot = join(directory, 'workspace');
  await mkdir(projectRoot);
  token = randomBytes(32).toString('base64url');
  hub = await createHub({
    dataDir: join(directory, 'hub'),
    adminToken: token,
    port: 0,
    webDir: resolve('dist/web'),
  });
  url = await hub.start();
  mcp = installMcp(hub, { dataDir: join(directory, 'hub'), publicUrl: url });
  const config = await pairDevice({
    url,
    code: hub.store.createPairing().code,
    name: 'UI test computer',
    roots: [projectRoot],
    allowShell: true,
    allowBrowser: true,
    dataDir: join(directory, 'agent'),
  });
  // Pairing reports the physical device path (for example /private/var on macOS).
  projectRoot = config.roots[0]!;
  config.pollMs = 100;
  controller = new AbortController();
  runner = runAgent(config, { signal: controller.signal });
});
test.afterAll(async () => {
  controller?.abort();
  await runner;
  mcp?.close();
  await hub?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('login, project, real command, file result, pairing and responsive navigation', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Токен владельца').fill('wrong-token');
  await page.getByRole('button', { name: 'Войти в Comand' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Токен владельца').fill(token);
  await page.getByRole('button', { name: 'Войти в Comand' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await page.getByRole('button', { name: 'Новый проект', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название проекта').fill('Проверка интерфейса');
  await dialog.getByLabel('Папка проекта, абсолютный путь').fill(projectRoot);
  await dialog
    .getByLabel('Заметки и инструкции')
    .fill('Реальный временный проект. Не содержит демонстрационных результатов.');
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/overview' && response.status() === 200,
  );
  await expect(page.getByRole('button', { name: 'Обновить данные', exact: true })).not.toHaveClass(
    /refreshing/,
  );
  // Let the poll's React commit and passive focus effects finish before checking stability.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(dialog.getByLabel('Заметки и инструкции')).toBeFocused();
  await dialog.getByRole('button', { name: 'Создать проект', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проверка интерфейса' })).toBeVisible();
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Команда', { exact: true })
    .fill("printf 'Comand UI: готово\\n'; printf 'created by UI' > ui-result.txt");
  await dialog.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Журнал выполнения')).toContainText('Comand UI: готово');
  await expect
    .poll(() => readFile(join(projectRoot, 'ui-result.txt'), 'utf8'))
    .toBe('created by UI');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Операция', { exact: true }).selectOption('files.read');
  await dialog.getByLabel('Путь относительно проекта').fill('ui-result.txt');
  await expect
    .poll(
      async () =>
        dialog.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const viewport = window.visualViewport;
          const left = viewport?.offsetLeft ?? 0;
          const width = viewport?.width ?? window.innerWidth;
          return {
            insideViewport: rect.left >= left - 2 && rect.right <= left + width + 2,
            hasHorizontalOverflow: element.scrollWidth > element.clientWidth + 2,
            scale: viewport?.scale ?? 1,
          };
        }),
      { message: 'Focused task form stays inside the visual viewport without automatic zoom' },
    )
    .toEqual({
      insideViewport: true,
      hasHorizontalOverflow: false,
      scale: 1,
    });
  await dialog.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.result-output')).toContainText('created by UI');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Устройства', exact: true }).click();
  await expect(page.getByText('UI test computer', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Подключить устройство', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await expect(page.getByText(`${url}/mcp`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 2,
  );
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('browser module returns an actual isolated page screenshot', async () => {
  const project =
    hub.store.listProjects()[0] ??
    hub.store.createProject({
      deviceId: hub.store.listDevices()[0]!.id,
      name: 'Browser test',
      root: projectRoot,
    });
  const job = hub.store.createJob({
    projectId: project.id,
    operation: { kind: 'browser.inspect', url, width: 800, height: 600, screenshot: true },
    idempotencyKey: `browser-${randomBytes(8).toString('hex')}`,
  });
  await expect
    .poll(() => hub.store.getJob(job.id)?.status, { timeout: 25_000 })
    .toMatch(/succeeded|failed/);
  const finished = hub.store.getJob(job.id)!;
  expect(finished.status, finished.error ?? '').toBe('succeeded');
  const result = finished.result as { title: string; screenshot: string; screenshotMime: string };
  expect(result.title.toLowerCase()).toContain('comand');
  expect(result.screenshotMime).toBe('image/jpeg');
  expect(Buffer.from(result.screenshot, 'base64').length).toBeGreaterThan(1000);
});
