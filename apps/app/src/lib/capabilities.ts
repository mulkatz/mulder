export type CapabilityState =
	| 'mounted-api'
	| 'mounted-partial'
	| 'cli-or-package-only'
	| 'documented-target'
	| 'future-milestone'
	| 'missing';

export type CapabilityId =
	| 'status.overview'
	| 'jobs.list'
	| 'jobs.detail'
	| 'documents.list'
	| 'documents.viewer'
	| 'evidence.summary'
	| 'evidence.contradictions'
	| 'evidence.claims'
	| 'search.hybrid'
	| 'entities.list'
	| 'graph.aggregate'
	| 'activity.feed'
	| 'usage.cost'
	| 'settings.admin'
	| 'm10.provenance';

export interface Capability {
	id: CapabilityId;
	label: string;
	state: CapabilityState;
	note: string;
}

export const capabilities = {
	'status.overview': {
		id: 'status.overview',
		label: 'System overview',
		state: 'mounted-api',
		note: 'GET /api/status is available.',
	},
	'jobs.list': {
		id: 'jobs.list',
		label: 'Job list',
		state: 'mounted-api',
		note: 'GET /api/jobs is available.',
	},
	'jobs.detail': {
		id: 'jobs.detail',
		label: 'Job detail',
		state: 'mounted-partial',
		note: 'GET /api/jobs/:id exists, but app run artifacts and timings need a stronger facade.',
	},
	'documents.list': {
		id: 'documents.list',
		label: 'Documents',
		state: 'mounted-api',
		note: 'GET /api/documents is available.',
	},
	'documents.viewer': {
		id: 'documents.viewer',
		label: 'Document viewer',
		state: 'mounted-partial',
		note: 'PDF, layout, pages, stories, and observability exist, but archive ingest is gated by M10 trust work.',
	},
	'evidence.summary': {
		id: 'evidence.summary',
		label: 'Evidence summary',
		state: 'mounted-api',
		note: 'GET /api/evidence/summary is available.',
	},
	'evidence.contradictions': {
		id: 'evidence.contradictions',
		label: 'Contradictions',
		state: 'mounted-api',
		note: 'GET /api/evidence/contradictions is available.',
	},
	'evidence.claims': {
		id: 'evidence.claims',
		label: 'Claim review',
		state: 'missing',
		note: 'First-class claims, assertions, and review actions need an app API contract.',
	},
	'search.hybrid': {
		id: 'search.hybrid',
		label: 'Hybrid search',
		state: 'mounted-api',
		note: 'POST /api/search is available.',
	},
	'entities.list': {
		id: 'entities.list',
		label: 'Entities',
		state: 'mounted-api',
		note: 'GET /api/entities is available.',
	},
	'graph.aggregate': {
		id: 'graph.aggregate',
		label: 'Graph',
		state: 'mounted-partial',
		note: 'Entity-local edges exist; aggregate graph read models are still needed.',
	},
	'activity.feed': {
		id: 'activity.feed',
		label: 'Activity',
		state: 'missing',
		note: 'No cross-system activity stream is mounted yet.',
	},
	'usage.cost': {
		id: 'usage.cost',
		label: 'Usage',
		state: 'mounted-partial',
		note: 'Status exposes budget pieces; a broader usage view is still needed.',
	},
	'settings.admin': {
		id: 'settings.admin',
		label: 'Settings',
		state: 'future-milestone',
		note: 'Workspace, policy, roles, and settings UI are future work.',
	},
	'm10.provenance': {
		id: 'm10.provenance',
		label: 'Provenance gate',
		state: 'future-milestone',
		note: 'Real archive ingest is gated by provenance, custody, quality, sensitivity/RBAC, and rollback.',
	},
} satisfies Record<CapabilityId, Capability>;

export function getCapability(id: CapabilityId) {
	return capabilities[id];
}

export function isCapabilityAvailable(id: CapabilityId) {
	const state = getCapability(id).state;
	return state === 'mounted-api' || state === 'mounted-partial';
}
