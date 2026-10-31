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
  await page.getByText('Другой способ входа', { exact: true }).click();
  await page.getByRole('button', { name: 'Войти по токену владельца' }).click();
  await page.getByLabel('Токен владельца', { exact: true }).fill('wrong-token');
  await page.getByRole('button', { name: 'Войти в Comand' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Токен владельца', { exact: true }).fill(token);
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
  let loggedModalGeometry = false;
  await expect
    .poll(
      async () => {
        const state = await dialog.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const viewport = window.visualViewport;
          const left = viewport?.offsetLeft ?? 0;
          const width = viewport?.width ?? window.innerWidth;
          const backdrop = element.closest<HTMLElement>('.modal-backdrop');
          const input = element.querySelector('input');
          const styles = getComputedStyle(element);
          return {
            checks: {
              insideViewport: rect.left >= left - 2 && rect.right <= left + width + 2,
              hasHorizontalOverflow: element.scrollWidth > element.clientWidth + 2,
              scale: viewport?.scale ?? 1,
            },
            geometry: {
              modalRect: rect.toJSON(),
              modalClientWidth: element.clientWidth,
              modalScrollWidth: element.scrollWidth,
              modalStyles: {
                width: styles.width,
                minWidth: styles.minWidth,
                maxWidth: styles.maxWidth,
                position: styles.position,
              },
              backdropRect: backdrop?.getBoundingClientRect().toJSON(),
              backdropScrollLeft: backdrop?.scrollLeft,
              backdropScrollWidth: backdrop?.scrollWidth,
              backdropClientWidth: backdrop?.clientWidth,
              innerWidth: window.innerWidth,
              scrollX: window.scrollX,
              documentClientWidth: document.documentElement.clientWidth,
              documentScrollWidth: document.documentElement.scrollWidth,
              bodyClientWidth: document.body.clientWidth,
              bodyScrollWidth: document.body.scrollWidth,
              visualViewport: viewport
                ? {
                    width: viewport.width,
                    offsetLeft: viewport.offsetLeft,
                    pageLeft: viewport.pageLeft,
                    scale: viewport.scale,
                  }
                : null,
              inputRect: input?.getBoundingClientRect().toJSON(),
              activeElement: document.activeElement?.tagName,
              activeElementRect: document.activeElement?.getBoundingClientRect().toJSON(),
              tableRect: document.querySelector('.table-scroll')?.getBoundingClientRect().toJSON(),
              tableScrollWidth: document.querySelector('.table-scroll')?.scrollWidth,
            },
          };
        });
        if (
          !loggedModalGeometry &&
          (!state.checks.insideViewport ||
            state.checks.hasHorizontalOverflow ||
            state.checks.scale !== 1)
        ) {
          loggedModalGeometry = true;
          console.log('COMAND_MOBILE_MODAL_GEOMETRY', JSON.stringify(state.geometry));
          await testInfo.attach('mobile-modal-geometry', {
            body: JSON.stringify(state.geometry, null, 2),
            contentType: 'application/json',
          });
        }
        return state.checks;
      },
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
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название устройства', { exact: true }).fill('Второй компьютер');
  await dialog.getByLabel('Рабочая папка, абсолютный путь', { exact: true }).fill(projectRoot);
  await dialog
    .getByLabel('Папка состояния агента', { exact: true })
    .fill(join(directory, 'another agent'));
  await dialog.getByRole('button', { name: 'Создать код подключения', exact: true }).click();
  await expect(dialog.locator('.command-box pre')).toContainText('/install.sh');
  await expect(dialog.locator('.command-box pre')).toContainText('bash "$comand_installer"');
  await dialog.getByRole('button', { name: 'Проверить подключение', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Новое устройство пока не появилось');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await expect(page.getByText(`${url}/mcp`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath('overview.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 2,
  );
  expect(overflow).toBe(false);
  await page
    .getByRole('button', { name: 'Аккаунт', exact: true })
    .filter({ visible: true })
    .click();
  await page.getByLabel('Ваше имя', { exact: true }).fill('Владелец рабочего сервера');
  await page
    .getByLabel('Электронная почта', { exact: true })
    .fill(`owner-${randomBytes(8).toString('hex')}@example.test`);
  await page.getByLabel('Новый пароль', { exact: true }).fill('a private owner passphrase');
  await page.getByRole('button', { name: 'Привязать аккаунт', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('recovery-code')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Я сохранил код в надёжном месте').check();
  await dialog.getByRole('button', { name: 'Перейти в рабочую среду' }).click();
  await page.getByRole('button', { name: 'Устройства', exact: true }).click();
  await expect(page.getByText('UI test computer', { exact: true }).first()).toBeVisible();
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

test('account signup, recovery acknowledgment, isolated empty workspace, password and login', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const email = `partner-${randomBytes(8).toString('hex')}@example.test`;
  const initialPassword = 'a thoughtful initial passphrase';
  const replacementPassword = 'a recovered private passphrase';
  const finalPassword = 'a newly updated secure passphrase';
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Вернёмся к работе.' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('login.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await page.getByLabel('Ваше имя', { exact: true }).fill('Александр');
  await page.getByLabel('Электронная почта', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(initialPassword);
  await page.getByRole('button', { name: 'Показать: пароль', exact: true }).click();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Скрыть: пароль', exact: true }).click();
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  const recovery = page.getByTestId('recovery-code');
  await expect(recovery).toBeVisible();
  const code = (await recovery.textContent())!;
  await expect(page.getByRole('button', { name: 'Перейти в рабочую среду' })).toBeDisabled();
  await page.getByLabel('Я сохранил код в надёжном месте').check();
  await page.getByRole('button', { name: 'Перейти в рабочую среду' }).click();
  await expect(page.getByRole('heading', { name: 'Начнём с подключения.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Первые шаги' })).toBeVisible();
  await expect(page.getByText('UI test computer', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('onboarding.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Аккаунт', exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Александр', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: 'Забыли пароль?' }).click();
  await page.getByLabel('Электронная почта', { exact: true }).fill(email);
  await page.getByLabel('Код восстановления', { exact: true }).fill('wrong-recovery-code');
  await page.getByLabel('Новый пароль', { exact: true }).fill(replacementPassword);
  await page.getByRole('button', { name: 'Восстановить доступ', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Новый пароль', { exact: true })).toHaveValue(replacementPassword);
  await expect(page.getByLabel('Электронная почта', { exact: true })).toHaveValue(email);
  await page.getByLabel('Код восстановления', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Восстановить доступ', exact: true }).click();
  await expect(recovery).toBeVisible();
  expect(await recovery.textContent()).not.toBe(code);
  await page.getByLabel('Я сохранил код в надёжном месте').check();
  await page.getByRole('button', { name: 'Перейти в рабочую среду' }).click();
  await page
    .getByRole('button', { name: 'Аккаунт', exact: true })
    .filter({ visible: true })
    .click();
  await page.getByLabel('Текущий пароль', { exact: true }).fill('incorrect current password');
  await page.getByLabel('Новый пароль', { exact: true }).fill(finalPassword);
  await page.getByRole('button', { name: 'Обновить пароль', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Новый пароль', { exact: true })).toHaveValue(finalPassword);
  await page.getByLabel('Текущий пароль', { exact: true }).fill(replacementPassword);
  await page.getByRole('button', { name: 'Обновить пароль', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Данные входа обновлены');
  await page.getByRole('button', { name: 'Выйти', exact: true }).filter({ visible: true }).click();
  await page.getByLabel('Электронная почта', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(finalPassword);
  await page.getByRole('button', { name: 'Войти в Comand', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Начнём с подключения.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Начнём с подключения.' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Тёмная тема', exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: testInfo.outputPath('onboarding-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2),
  ).toBe(false);
  expect(errors).toEqual([]);
});
