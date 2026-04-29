import { expect, test } from '@playwright/test';

// QA-11: Smoke test — loads /archive/:id, waits for PDF canvas, asserts story frames exist.
// Requires the local API server (http://localhost:8787) and database to be running.
test('case file renders PDF and story frames', async ({ page, request }) => {
  // Check if API is reachable — skip gracefully if not.
  let documentId: string | undefined;
  try {
    const response = await request.get('http://localhost:8787/api/documents?limit=1');
    if (!response.ok()) {
      test.skip();
      return;
    }
    const body = await response.json();
    documentId = body?.data?.[0]?.id;
  } catch {
    test.skip();
    return;
  }

  if (!documentId) {
    test.skip();
    return;
  }

  await page.goto(`/archive/${documentId}`);
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.story-frame').first()).toBeVisible();
});
