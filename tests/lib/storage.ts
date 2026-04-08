/**
 * Shared test helper: snapshot/diff cleanup for `.local/storage/*` directories.
 *
 * Dev-mode ingests write to `.local/storage/raw/{sourceId}/original.pdf`.
 * Tests that invoke `mulder ingest` must clean up these entries in `afterAll`
 * or they accumulate across runs.
 *
 * Usage:
 *
 *   let snapshot: StorageSnapshot;
 *
 *   beforeAll(() => {
 *     snapshot = snapshotStorageDir('.local/storage/raw');
 *   });
 *
 *   afterAll(() => {
 *     cleanStorageDirSince(snapshot);
 *   });
 *
 * The snapshot captures the set of child entry names at setup time. The
 * cleanup deletes any entries added since, leaving pre-existing data
 * untouched — so running tests in a dirty repo is still safe.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type StorageSnapshot = {
	readonly dir: string;
	readonly entries: ReadonlySet<string>;
};

/**
 * Capture the current set of child entry names in `dir`. Returns an empty set
 * if the directory does not yet exist.
 */
export function snapshotStorageDir(dir: string): StorageSnapshot {
	if (!existsSync(dir)) {
		return { dir, entries: new Set() };
	}
	return { dir, entries: new Set(readdirSync(dir)) };
}

/**
 * Delete every entry in `snapshot.dir` that was not present at snapshot time.
 * No-op if the directory does not exist. Non-throwing — teardown errors are
 * printed to stderr but never break the test.
 */
export function cleanStorageDirSince(snapshot: StorageSnapshot): void {
	if (!existsSync(snapshot.dir)) {
		return;
	}
	for (const entry of readdirSync(snapshot.dir)) {
		if (snapshot.entries.has(entry)) continue;
		try {
			rmSync(join(snapshot.dir, entry), { recursive: true, force: true });
		} catch (err) {
			console.warn(`cleanStorageDirSince: failed to remove ${entry}: ${String(err)}`);
		}
	}
}
