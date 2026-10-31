import { access } from 'node:fs/promises';
import type { Browser, BrowserType } from 'playwright';

interface BrowserLaunchEnvironment {
  channel?: string;
  platform?: NodeJS.Platform;
  executableExists?: (file: string) => Promise<boolean>;
}

/** All launches use Playwright's disposable profile, never an existing user profile. */
export async function launchInspectionBrowser(
  chromium: Pick<BrowserType<Browser>, 'launch'>,
  environment: BrowserLaunchEnvironment = {},
): Promise<Browser> {
  const channel = environment.channel ?? process.env.COMAND_BROWSER_CHANNEL;
  const platform = environment.platform ?? process.platform;
  const executableExists =
    environment.executableExists ??
    ((file) =>
      access(file).then(
        () => true,
        () => false,
      ));
  if (channel && channel !== 'chrome' && channel !== 'chromium') {
    throw new Error('COMAND_BROWSER_CHANNEL must be chrome or chromium.');
  }
  try {
    return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  } catch (originalError) {
    const message = originalError instanceof Error ? originalError.message : String(originalError);
    const missingExecutable =
      /executable.*(?:doesn.t exist|not found)|cannot find.*executable|distribution.*not found/i.test(
        message,
      );
    if (!channel && missingExecutable) {
      const chromePaths =
        platform === 'darwin'
          ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
          : platform === 'linux'
            ? ['/opt/google/chrome/chrome']
            : [];
      for (const executable of chromePaths) {
        if (await executableExists(executable)) {
          try {
            return await chromium.launch({ headless: true, channel: 'chrome' });
          } catch (fallbackError) {
            throw new Error(
              `Installed Google Chrome could not start in an isolated profile. Run npx playwright install chromium or check COMAND_BROWSER_CHANNEL=chrome. ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            );
          }
        }
      }
    }
    if (missingExecutable) {
      throw new Error(
        `Browser unavailable. Run npx playwright install chromium, or install Google Chrome and set COMAND_BROWSER_CHANNEL=chrome. ${message}`,
      );
    }
    throw originalError;
  }
}
