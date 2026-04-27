import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

interface BrowserIssue {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'api';
  message: string;
}

function isAllowedApiError(url: string, status: number) {
  const parsed = new URL(url);
  return parsed.pathname === '/api/auth/session' && status === 401;
}

function formatIssue(issue: BrowserIssue) {
  return `[${issue.kind}] ${issue.message}`;
}

function isAllowedConsoleError(message: string) {
  return message === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
}

function isAllowedRequestFailure(url: string, failureText: string) {
  const hostname = new URL(url).hostname;
  if (hostname === 'fonts.gstatic.com' || hostname === 'fonts.googleapis.com') {
    return true;
  }

  return new URL(url).pathname === '/api/auth/logout' && failureText === 'net::ERR_ABORTED';
}

async function attachDiagnostics(testInfo: TestInfo, issues: BrowserIssue[]) {
  if (issues.length === 0) {
    return;
  }

  await testInfo.attach('browser-diagnostics.txt', {
    body: issues.map(formatIssue).join('\n'),
    contentType: 'text/plain',
  });
}

async function guardPage(page: Page, runTest: (page: Page) => Promise<void>, testInfo: TestInfo) {
  const issues: BrowserIssue[] = [];

  page.on('console', (message) => {
    if (message.type() !== 'error' || isAllowedConsoleError(message.text())) {
      return;
    }

    issues.push({
      kind: 'console',
      message: message.text(),
    });
  });

  page.on('pageerror', (error) => {
    issues.push({
      kind: 'pageerror',
      message: error.stack ?? error.message,
    });
  });

  page.on('requestfailed', (request) => {
    const failureText = request.failure()?.errorText ?? 'failed';
    if (isAllowedRequestFailure(request.url(), failureText)) {
      return;
    }

    issues.push({
      kind: 'requestfailed',
      message: `${request.method()} ${request.url()} ${failureText}`,
    });
  });

  page.on('response', (response) => {
    const url = response.url();
    const status = response.status();
    if (!url.includes('/api/') || status < 400 || isAllowedApiError(url, status)) {
      return;
    }

    issues.push({
      kind: 'api',
      message: `${status} ${response.request().method()} ${url}`,
    });
  });

  await runTest(page);
  await attachDiagnostics(testInfo, issues);

  expect(issues.map(formatIssue)).toEqual([]);
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await guardPage(page, use, testInfo);
  },
});

export { expect };
