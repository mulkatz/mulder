import { test, expect } from '../fixtures/test';
import { E2E_INVITE_TOKEN, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD } from './constants';

test.use({ storageState: { cookies: [], origins: [] } });

test('auth gate renders login in place for protected routes', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Enter the archive' })).toBeVisible();
});

test('login and logout use the cookie-backed browser session', async ({ page }) => {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(E2E_OWNER_EMAIL);
  await page.getByLabel('Password').fill(E2E_OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Enter' }).click();

  await expect(page.getByRole('heading', { name: 'The archive is awake.' })).toBeVisible();
  await expect(page.getByText(E2E_OWNER_EMAIL)).toBeVisible();

  const logoutResponse = page.waitForResponse((response) =>
    response.url().includes('/api/auth/logout') && response.status() === 204,
  );
  await page.getByRole('button', { name: 'Log out' }).click();
  await logoutResponse;
  await expect(page).toHaveURL('/auth/login');
  await expect(page.getByRole('heading', { name: 'Enter the archive' })).toBeVisible();
});

test('invitation acceptance creates a browser session without exposing the raw token', async ({ page }) => {
  await page.goto(`/auth/invitations/${E2E_INVITE_TOKEN}`);

  await expect(page.getByRole('heading', { name: 'You have been invited to the Mulder archive.' })).toBeVisible();
  await expect(page.getByText(E2E_INVITE_TOKEN)).toHaveCount(0);

  await page.getByLabel('Password', { exact: true }).fill('member password for e2e');
  await page.getByLabel('Confirm password').fill('member password for e2e');
  await page.getByRole('button', { name: 'Enter' }).click();

  await expect(page.getByRole('heading', { name: 'The archive is awake.' })).toBeVisible();
  await expect(page.getByText(E2E_INVITE_TOKEN)).toHaveCount(0);
});
