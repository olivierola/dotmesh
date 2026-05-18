import { test, expect } from '@playwright/test';

test.describe('Landing page', () => {
  test('shows hero and navigates to dashboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /second brain/i })).toBeVisible();

    // Navbar should be visible
    await expect(page.getByRole('button', { name: /Problem/i })).toBeVisible();

    // Open dashboard button → /dashboard
    await page.getByRole('link', { name: /Open dashboard/i }).first().click();
    await expect(page).toHaveURL(/.*\/dashboard/);
    await expect(page.getByRole('heading', { name: /^Dashboard$/i })).toBeVisible();
  });

  test('smooth-scrolls to pricing section', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Pricing' }).click();
    await expect(page.getByRole('heading', { name: /Generous free tier/i })).toBeInViewport();
  });
});
