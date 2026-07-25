import { expect, test } from '@playwright/test';

/**
 * Smoke tests that need no network beyond the app itself.
 *
 * Anything that would hit github.com lives in `analysis.spec.ts` and is
 * skipped when the network is unavailable, so a contributor on a plane still
 * gets a meaningful E2E signal.
 */

test.describe('landing page', () => {
  test('renders the hero and the analyze form', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Understand any codebase');
    await expect(page.getByPlaceholder('github.com/owner/repo')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Analyze' })).toBeVisible();
  });

  test('states whether it is running in local mode', async ({ page }) => {
    await page.goto('/');
    // With no OPENROUTER_API_KEY the product must say so rather than imply AI.
    await expect(page.getByText(/No API key required|LLM answers enabled/)).toBeVisible();
  });

  test('keeps the analyze button disabled until a URL is entered', async ({ page }) => {
    await page.goto('/');

    const analyze = page.getByRole('button', { name: 'Analyze' });
    await expect(analyze).toBeDisabled();

    await page.getByPlaceholder('github.com/owner/repo').fill('github.com/acme/demo');
    await expect(analyze).toBeEnabled();
  });

  test('rejects a non-GitHub URL with a readable message', async ({ page }) => {
    await page.goto('/');

    await page.getByPlaceholder('github.com/owner/repo').fill('https://gitlab.com/acme/demo');
    await page.getByRole('button', { name: 'Analyze' }).click();

    // Next.js renders an always-present, empty route announcer with
    // role="alert", so the error alert has to be selected by its content.
    await expect(page.getByRole('alert').filter({ hasText: /github\.com/i })).toContainText(
      /only github\.com/i,
    );
  });

  test('has no horizontal overflow at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });

  test('exposes a skip link as the first tab stop', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });
});

test.describe('dashboard', () => {
  test('renders an honest empty state before anything is analyzed', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: 'Analyses' })).toBeVisible();
    // Either state is valid depending on whether other tests ran first.
    await expect(page.getByText(/No analyses yet|repositor(y|ies) analyzed/)).toBeVisible();
  });
});

test.describe('error handling', () => {
  test('shows a helpful 404 for an unknown analysis id', async ({ page }) => {
    await page.goto('/r/does-not-exist-at-all');

    await expect(page.getByText(/not available/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /Analyze a repository/i })).toBeVisible();
  });
});

test.describe('API contract', () => {
  test('rejects a malformed analyze payload with 4xx and a JSON error', async ({ request }) => {
    const response = await request.post('/api/analyze', { data: { notAUrl: true } });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);

    const body = (await response.json()) as { error?: { message?: string; code?: string } };
    expect(body.error?.message).toBeTruthy();
  });

  test('rejects a non-GitHub host, closing the SSRF vector', async ({ request }) => {
    const response = await request.post('/api/analyze', {
      data: { url: 'http://169.254.169.254/latest/meta-data' },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/github\.com/i);
  });

  test('returns 404 for search against an unknown analysis', async ({ request }) => {
    const response = await request.get('/api/search?id=nope&q=auth');
    expect(response.status()).toBe(404);
  });

  test('sets hardening headers on API responses', async ({ request }) => {
    const response = await request.get('/api/search?id=nope&q=auth');

    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['x-frame-options']).toBe('DENY');
  });
});
