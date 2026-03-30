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

import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { VertexAI } from '@google-cloud/vertexai';

// ────────────────────────────────────────────────────────────
// Lazy singletons
// ────────────────────────────────────────────────────────────

let storageClient: Storage | undefined;
let documentAiClient: DocumentProcessorServiceClient | undefined;
let vertexAiClient: VertexAI | undefined;
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
 * Returns a lazily-initialized Document AI client.
 * Uses Application Default Credentials.
 */
export function getDocumentAIClient(): DocumentProcessorServiceClient {
	if (!documentAiClient) {
		documentAiClient = new DocumentProcessorServiceClient();
	}
	return documentAiClient;
}

/**
 * Returns a lazily-initialized Vertex AI client.
 * Requires project and location from config at init time.
 */
export function getVertexAI(project: string, location: string): VertexAI {
	if (!vertexAiClient) {
		vertexAiClient = new VertexAI({ project, location });
	}
	return vertexAiClient;
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

	if (documentAiClient) {
		tasks.push(documentAiClient.close());
		documentAiClient = undefined;
	}

	// Storage client does not have a close method — just reset
	storageClient = undefined;

	// VertexAI client does not have a close method — just reset
	vertexAiClient = undefined;

	await Promise.all(tasks);
}
