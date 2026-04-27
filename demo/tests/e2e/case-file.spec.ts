import { test, expect } from '../fixtures/test';
import { E2E_FIRST_STORY_ID, E2E_SECOND_STORY_ID, E2E_SOURCE_ID } from './constants';

async function openCaseFile(page: import('@playwright/test').Page) {
  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: 'Open a case file.' })).toBeVisible();
  await page.getByRole('link', { name: /mulder-demo-case-file\.pdf/ }).click();
  await expect(page).toHaveURL(`/archive/${E2E_SOURCE_ID}`);
  await expect(page.getByRole('heading', { name: 'mulder-demo-case-file.pdf' })).toBeVisible();
}

test('theme toggle persists across reloads', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('archive opens the seeded case file', async ({ page }) => {
  await openCaseFile(page);

  await expect(page.locator('[data-testid="pdf-page"][data-page="1"] canvas')).toBeVisible();
  await expect(page.getByTestId('story-frame').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Project Blue Book notes/ })).toBeVisible();
});

test('case file supports story expansion, entity hover, drawer, thumbnails, and reading mode', async ({ page }) => {
  await openCaseFile(page);

  await expect(page.locator(`[data-testid="story-frame"][data-story-id="${E2E_FIRST_STORY_ID}"]`)).toBeVisible();
  await page.getByRole('button', { name: /Project Blue Book notes/ }).click();

  const hynekPill = page
    .locator(`[data-testid="story-list-item"][data-story-id="${E2E_FIRST_STORY_ID}"]`)
    .getByTestId('entity-pill')
    .filter({ hasText: 'Josef Allen Hynek' })
    .first();
  await expect(hynekPill).toBeVisible();

  await hynekPill.hover();
  await expect(page.getByTestId('entity-hover-card')).toBeVisible();
  await expect(page.locator('mark.amber-underline-active').first()).toBeVisible();

  await page.mouse.move(0, 0);
  await expect(page.getByTestId('entity-hover-card')).toBeHidden();
  await hynekPill.click();
  await expect(page.getByTestId('entity-profile-drawer')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Josef Allen Hynek' })).toBeVisible();
  await expect(page.getByText('Dr. Hynek')).toBeVisible();
  await expect(page.getByText('INVESTIGATED_AT')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('entity-profile-drawer')).toBeHidden();

  const secondPageThumbnail = page.locator('[data-testid="page-thumbnail"][data-page="2"]');
  await secondPageThumbnail.click();
  await expect(secondPageThumbnail).toHaveAttribute('data-active', 'true');

  const activeStoryAfterThumbnail = page.locator(`[data-testid="story-list-item"][data-story-id="${E2E_SECOND_STORY_ID}"]`);
  await expect(activeStoryAfterThumbnail).toBeVisible();
  await activeStoryAfterThumbnail.getByTestId('read-full-story').click();
  await expect(page).toHaveURL(`/archive/${E2E_SOURCE_ID}/read/${E2E_SECOND_STORY_ID}`);
  await expect(page.getByTestId('story-reader')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(`/archive/${E2E_SOURCE_ID}`);
});

test('future demo pages render their current placeholder states without claiming completion', async ({ page }) => {
  await page.goto('/board');
  await expect(page.getByRole('heading', { name: 'The graph arrives in the next phase.' })).toBeVisible();

  await page.goto('/ask');
  await expect(page.getByRole('heading', { name: 'The archive can answer, soon.' })).toBeVisible();
});
