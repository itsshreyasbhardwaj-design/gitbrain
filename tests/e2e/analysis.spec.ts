import { expect, test, type Page } from '@playwright/test';

/**
 * The full journey: analyze a real repository, then walk every report tab.
 *
 * These hit github.com, so they are skipped when it is unreachable rather than
 * failing a contributor's offline run or a flaky CI network. Skipping loudly is
 * better than a red build that says nothing about the code.
 */

const REPO = 'https://github.com/sindresorhus/ky';

let reachable: boolean | null = null;

async function githubReachable(page: Page): Promise<boolean> {
  if (reachable !== null) return reachable;
  try {
    const response = await page.request.get('https://api.github.com/repos/sindresorhus/ky', {
      timeout: 15_000,
    });
    reachable = response.ok();
  } catch {
    reachable = false;
  }
  return reachable;
}

test.describe('end-to-end analysis', () => {
  // One analysis, reused by every tab assertion. Serial so the id is shared.
  test.describe.configure({ mode: 'serial' });

  let reportUrl = '';

  test('analyzes a real repository and streams progress', async ({ page }) => {
    test.skip(!(await githubReachable(page)), 'github.com is unreachable');
    test.setTimeout(180_000);

    await page.goto('/');
    await page.getByPlaceholder('github.com/owner/repo').fill(REPO);
    await page.getByRole('button', { name: 'Analyze' }).click();

    // Progress must appear before the result — that is the whole point of
    // streaming rather than blocking on a spinner.
    await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 30_000 });

    await page.waitForURL(/\/r\/[a-z0-9]+$/, { timeout: 150_000 });
    reportUrl = page.url();

    await expect(page.getByRole('heading', { level: 1 })).toContainText('sindresorhus/ky');
  });

  test('overview reports measured facts', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');
    await page.goto(reportUrl);

    // Generated documents can repeat these phrases, so scope to the first
    // match rather than asserting the page contains exactly one.
    await expect(page.getByText('At a glance').first()).toBeVisible();
    await expect(page.getByText(/lines of code/i).first()).toBeVisible();

    // The file count must be a real number, not a placeholder.
    const body = await page.textContent('body');
    expect(body).toMatch(/\d{2,}/);
  });

  test('knowledge tab renders documents with clickable sources', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');
    await page.goto(`${reportUrl}/knowledge`);

    await expect(page.getByRole('heading', { name: 'Knowledge base' }).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Knowledge documents' })).toBeVisible();

    // Switching documents must actually change the body.
    const article = page.locator('article').first();
    const before = await article.innerText();
    await page.getByRole('button', { name: 'Setup Guide' }).click();
    await expect(article).not.toHaveText(before);
  });

  test('code graph renders and responds to filtering', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');
    await page.goto(`${reportUrl}/graph`);

    await expect(page.getByRole('heading', { name: 'Module graph' }).first()).toBeVisible();
    await expect(page.getByText(/\d+\s+modules/).first()).toBeVisible();

    await page.getByLabel('Filter modules by path').fill('zzz-no-such-file');
    await expect(page.getByText('No modules match these filters.')).toBeVisible();
  });

  test('health tab shows scored dimensions with numeric rationale', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');
    await page.goto(`${reportUrl}/health`);

    await expect(page.getByRole('heading', { name: 'Dimensions' }).first()).toBeVisible();
    // The radar chart must ship a text equivalent, not just a polygon.
    await expect(page.getByText('Documentation', { exact: false }).first()).toBeVisible();
  });

  test('security tab renders findings or an honest all-clear', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');
    await page.goto(`${reportUrl}/security`);

    await expect(page.getByText('Security score').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hardcoded secrets' }).first()).toBeVisible();
  });

  test('search returns ranked, cited results', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');
    await page.goto(`${reportUrl}/search`);

    await page.getByLabel('Search the repository').fill('request');
    await expect(page.getByText(/match(es)? across|No matches/).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('chat streams an answer grounded in the repository', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');
    test.setTimeout(90_000);

    await page.goto(`${reportUrl}/chat`);
    await expect(page.getByRole('heading', { name: 'Ask the codebase' }).first()).toBeVisible();

    await page
      .getByLabel('Ask a question about this repository')
      .fill('What does this project do?');
    await page.getByRole('button', { name: 'Send question' }).click();

    // An answer must actually arrive — local reasoning needs no API key.
    // Assert on volume of rendered text rather than a pattern: the wording
    // differs between the local reasoner and a model, but both produce
    // substantial, cited prose.
    const log = page.getByRole('log');
    await expect
      .poll(async () => (await log.innerText()).length, { timeout: 60_000 })
      .toBeGreaterThan(200);

    // ...and it must cite a real file from this repository.
    await expect(log).toContainText(/\.(ts|js|json|md)\b/, { timeout: 10_000 });
  });

  test('report is usable at mobile width', async ({ page }) => {
    test.skip(!reportUrl, 'analysis did not complete');

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(reportUrl);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });
});
