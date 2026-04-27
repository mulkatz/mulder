import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { test, expect } from '../fixtures/test';
import { E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD } from './constants';

const authStatePath = 'tests/.auth/owner.json';

test('authenticates the seeded owner through the browser login form', async ({ page }) => {
  await page.goto('/auth/login');

  await expect(page.getByRole('heading', { name: 'Enter the archive' })).toBeVisible();
  await page.getByLabel('Email').fill(E2E_OWNER_EMAIL);
  await page.getByLabel('Password').fill(E2E_OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Enter' }).click();

  await expect(page.getByRole('heading', { name: 'A live briefing from the archive.' })).toBeVisible();
  mkdirSync(dirname(authStatePath), { recursive: true });
  await page.context().storageState({ path: authStatePath });
});
