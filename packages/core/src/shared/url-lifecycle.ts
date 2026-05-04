/**
 * Shared helpers for URL lifecycle freshness and host politeness.
 *
 * The persistence lives in the database repository; these helpers keep the
 * normalization and environment parsing identical for ingest and re-fetch.
 *
 * @see docs/specs/94_url_lifecycle_refetch.spec.md
 */

const DEFAULT_URL_POLITENESS_DELAY_MS = 1000;
const MAX_URL_POLITENESS_DELAY_MS = 60_000;

export function normalizeUrlLifecycleHost(url: string): string {
	return new URL(url).host.toLowerCase();
}

export function headerValue(headers: Record<string, string>, name: string): string | null {
	return headers[name.toLowerCase()] ?? null;
}

export function computeUrlLifecycleNextAllowedAt(requestedAt: Date, minimumDelayMs: number): Date {
	return new Date(requestedAt.getTime() + Math.max(0, minimumDelayMs));
}

export function resolveUrlPolitenessDelayMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.MULDER_URL_POLITENESS_DELAY_MS;
	if (raw === undefined || raw.trim() === '') {
		return DEFAULT_URL_POLITENESS_DELAY_MS;
	}

	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_URL_POLITENESS_DELAY_MS;
	}

	return Math.min(Math.max(parsed, 0), MAX_URL_POLITENESS_DELAY_MS);
}

export async function sleepForUrlPoliteness(ms: number): Promise<void> {
	if (ms <= 0) {
		return;
	}
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
