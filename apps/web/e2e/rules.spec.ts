import { test, expect } from '@playwright/test';

test.describe('Context Rules (mock mode)', () => {
  test('add a rule and delete it', async ({ page }) => {
    await page.goto('/rules');
    await expect(page.getByRole('heading', { name: /Context Rules/i })).toBeVisible();

    // Existing seed rule
    await expect(page.getByText('DENY')).toBeVisible();

    // Add a new tag-blocking rule for Claude
    await page.locator('select').first().selectOption('claude.ai');
    await page.getByPlaceholder(/tags, comma-separated/i).fill('finance');
    await page.getByRole('button', { name: /Add rule/i }).click();

    await expect(page.getByText(/claude\.ai/i)).toBeVisible();
    await expect(page.getByText('tags: finance')).toBeVisible();
  });
});
