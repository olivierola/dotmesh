import { test, expect } from '@playwright/test';

test.describe('Timeline (mock mode)', () => {
  test('lists seed memories and creates a new one', async ({ page }) => {
    await page.goto('/timeline');
    await expect(page.getByRole('heading', { name: /Memory Timeline/i })).toBeVisible();

    // Seed nodes contain "Sophie"
    await expect(page.getByText(/Sophie/i).first()).toBeVisible();

    const input = page.getByPlaceholder(/Add a memory manually/i);
    await input.fill('E2E test capture about Pluto');
    await page.getByRole('button', { name: 'Capture' }).click();

    await expect(page.getByText(/E2E test capture about Pluto/i)).toBeVisible();
  });

  test('deletes a node', async ({ page }) => {
    await page.goto('/timeline');
    const initialCount = await page.locator('ul li').count();
    await page.locator('button:has-text("delete")').first().click();
    await expect(page.locator('ul li')).toHaveCount(initialCount - 1);
  });
});
