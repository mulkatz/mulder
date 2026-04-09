/**
 * GCP Connection Manager — lazy-initialized singleton GCP SDK clients.
 *
 * Each getter creates the client on first call, returns the cached instance
 * on subsequent calls. Pipeline steps NEVER import this file directly —
 * only `services.gcp.ts` does.
 *
 * Uses Application Default Credentials (ADC) — no service account JSON in code.
 *
 * @see docs/specs/13_gcp_service_implementations.spec.md §4.3
 * @see docs/functional-spec.md §4.6
 */

import { GoogleGenAI } from '@google/genai';
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';

// ────────────────────────────────────────────────────────────
// Lazy singletons
// ────────────────────────────────────────────────────────────

export type DocumentAiLocation = 'eu' | 'us';

let storageClient: Storage | undefined;
const documentAiClients = new Map<DocumentAiLocation, DocumentProcessorServiceClient>();
let genAiClient: GoogleGenAI | undefined;
let firestoreClient: Firestore | undefined;

/**
 * Returns a lazily-initialized Cloud Storage client.
 * Uses Application Default Credentials.
 */
export function getStorageClient(): Storage {
	if (!storageClient) {
		storageClient = new Storage();
	}
	return storageClient;
}

/**
 * Returns a lazily-initialized Document AI client for the given multi-region
 * location. The SDK's default (global) endpoint routes to `us`, so calls
 * against EU-located processors 404 with `PROCESSOR_NOT_FOUND`. Each location
 * gets its own cached client constructed with the matching regional endpoint
 * (`eu-documentai.googleapis.com` or `us-documentai.googleapis.com`).
 *
 * Uses Application Default Credentials.
 */
export function getDocumentAIClient(location: DocumentAiLocation): DocumentProcessorServiceClient {
	let client = documentAiClients.get(location);
	if (!client) {
		client = new DocumentProcessorServiceClient({
			apiEndpoint: `${location}-documentai.googleapis.com`,
		});
		documentAiClients.set(location, client);
	}
	return client;
}

/**
 * Returns a lazily-initialized Google GenAI client (Vertex AI backend).
 * Requires project and location from config at init time.
 */
export function getGenAI(project: string, location: string): GoogleGenAI {
	if (!genAiClient) {
		genAiClient = new GoogleGenAI({ vertexai: true, project, location });
	}
	return genAiClient;
}

/**
 * Returns a lazily-initialized Firestore client.
 * Requires project from config at init time.
 */
export function getFirestoreClient(project: string): Firestore {
	if (!firestoreClient) {
		firestoreClient = new Firestore({ projectId: project });
	}
	return firestoreClient;
}

// ────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────

/**
 * Closes all GCP clients for graceful shutdown.
 * Safe to call multiple times — resets singletons to undefined.
 */
export async function closeGcpClients(): Promise<void> {
	const tasks: Promise<void>[] = [];

	if (firestoreClient) {
		tasks.push(firestoreClient.terminate());
		firestoreClient = undefined;
	}

	for (const client of documentAiClients.values()) {
		tasks.push(client.close());
	}
	documentAiClients.clear();

	// Storage client does not have a close method — just reset
	storageClient = undefined;

	// GoogleGenAI client does not have a close method — just reset
	genAiClient = undefined;

	await Promise.all(tasks);
}
