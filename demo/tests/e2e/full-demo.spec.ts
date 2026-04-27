import { resolve } from 'node:path';
import { test, expect } from '../fixtures/test';
import { E2E_SOURCE_ID } from './constants';

test('desk shows real corpus, job, and evidence data', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'A live briefing from the archive.' })).toBeVisible();
  await expect(page.getByText('Documents', { exact: true })).toBeVisible();
  await expect(page.getByText('Insufficient', { exact: true })).toBeVisible();
  await expect(page.getByText('Recent jobs')).toBeVisible();

  await page.getByRole('button', { name: 'Open Audit drawer' }).click();
  await expect(page.getByRole('heading', { name: 'What the archive believes.' })).toBeVisible();
  await page.getByRole('tab', { name: /Contradictions/ }).click();
  await expect(page.getByRole('heading', { name: 'EVENT_TIME' })).toBeVisible();
});

test('archive filters documents and duplicate upload runs through the worker', async ({ page }) => {
  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: 'Browse the document stack.' })).toBeVisible();

  await page.getByPlaceholder('Area 51, Hynek...').fill('phoenix');
  await expect(page.getByRole('link', { name: /phoenix-lights-field-notes\.pdf/ })).toBeVisible();

  await page.getByRole('button', { name: /Upload PDF/ }).click();
  await page.getByTestId('document-upload-input').setInputFiles(resolve('../fixtures/raw/native-text-sample.pdf'));
  await expect(page.getByText('Duplicate detected. Opening the existing source.')).toBeVisible({ timeout: 30_000 });
});

test('ask returns citations and opens the cited Case File', async ({ page }) => {
  await page.goto('/ask');

  await page.getByLabel('Search query').fill('How does Hynek connect to Area 51?');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByText('Top cited passage')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Citations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Project Blue Book notes/ }).click();
  await expect(page).toHaveURL(`/archive/${E2E_SOURCE_ID}`);
});

test('command palette navigates and triggers actions', async ({ page }) => {
  await page.goto('/');

  await page.keyboard.press('Control+K');
  await expect(page.getByPlaceholder('Search documents, entities, and actions...')).toBeVisible();
  await page.getByTestId('command-item-board').click();
  await expect(page).toHaveURL('/board');

  await page.keyboard.press('Control+.');
  await expect(page.getByRole('heading', { name: 'What the archive believes.' })).toBeVisible();
});

test('board graph supports filters, list view, and node detail drawer', async ({ page }) => {
  await page.goto('/board');

  await expect(page.getByRole('heading', { name: 'The entity graph, capped and honest.' })).toBeVisible();
  await expect(page.getByText('Project Blue Book')).toBeVisible();

  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('button', { name: /Josef Allen Hynek/ }).click();
  await expect(page.getByTestId('entity-profile-drawer')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Josef Allen Hynek' })).toBeVisible();
});
