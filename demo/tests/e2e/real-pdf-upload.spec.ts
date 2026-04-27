import { resolve } from 'node:path';
import { test, expect } from '../fixtures/test';

test('archive upload accepts a real repository PDF and surfaces worker finalization', async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: 'Browse the document stack.' })).toBeVisible();

  await page.getByRole('button', { name: /Upload PDF/ }).click();
  await page
    .getByTestId('document-upload-input')
    .setInputFiles(resolve('../tests/data/pdf/1950-01-9613320-Corona-NewMexico.pdf'));

  await expect(page.getByRole('button', { name: 'Working...' })).toBeVisible();
  await expect(page.getByText('Upload finalized. Pipeline worker has accepted the document.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/Job [0-9a-f-]{36}/)).toBeVisible();

  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByPlaceholder('Area 51, Hynek...').fill('Corona');
  await expect(page.getByRole('link', { name: /1950-01-9613320-Corona-NewMexico\.pdf/ })).toBeVisible();
});
