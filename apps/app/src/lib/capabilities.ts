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
	| 'workspace.reviewQueue'
	| 'workspace.watchlist'
	| 'workspace.agent'
	| 'documents.list'
	| 'documents.viewer'
	| 'sources.add'
	| 'evidence.summary'
	| 'evidence.contradictions'
	| 'evidence.claims'
	| 'evidence.reliability'
	| 'evidence.chains'
	| 'evidence.clusters'
	| 'search.hybrid'
	| 'entities.list'
	| 'relationships.list'
	| 'graph.aggregate'
	| 'taxonomy.manage'
	| 'stories.list'
	| 'activity.feed'
	| 'operations.recovery'
	| 'usage.cost'
	| 'exports.list'
	| 'settings.admin'
	| 'admin.members'
	| 'admin.policies'
	| 'admin.integrations'
	| 'm10.provenance';

export interface Capability {
	id: CapabilityId;
	state: CapabilityState;
}

export const capabilities = {
	'status.overview': {
		id: 'status.overview',
		state: 'mounted-api',
	},
	'jobs.list': {
		id: 'jobs.list',
		state: 'mounted-api',
	},
	'jobs.detail': {
		id: 'jobs.detail',
		state: 'mounted-partial',
	},
	'workspace.reviewQueue': {
		id: 'workspace.reviewQueue',
		state: 'documented-target',
	},
	'workspace.watchlist': {
		id: 'workspace.watchlist',
		state: 'documented-target',
	},
	'workspace.agent': {
		id: 'workspace.agent',
		state: 'future-milestone',
	},
	'documents.list': {
		id: 'documents.list',
		state: 'mounted-api',
	},
	'documents.viewer': {
		id: 'documents.viewer',
		state: 'mounted-partial',
	},
	'sources.add': {
		id: 'sources.add',
		state: 'future-milestone',
	},
	'evidence.summary': {
		id: 'evidence.summary',
		state: 'mounted-api',
	},
	'evidence.contradictions': {
		id: 'evidence.contradictions',
		state: 'mounted-api',
	},
	'evidence.claims': {
		id: 'evidence.claims',
		state: 'missing',
	},
	'evidence.reliability': {
		id: 'evidence.reliability',
		state: 'mounted-api',
	},
	'evidence.chains': {
		id: 'evidence.chains',
		state: 'mounted-api',
	},
	'evidence.clusters': {
		id: 'evidence.clusters',
		state: 'mounted-api',
	},
	'search.hybrid': {
		id: 'search.hybrid',
		state: 'mounted-api',
	},
	'entities.list': {
		id: 'entities.list',
		state: 'mounted-api',
	},
	'relationships.list': {
		id: 'relationships.list',
		state: 'mounted-partial',
	},
	'graph.aggregate': {
		id: 'graph.aggregate',
		state: 'mounted-partial',
	},
	'taxonomy.manage': {
		id: 'taxonomy.manage',
		state: 'cli-or-package-only',
	},
	'stories.list': {
		id: 'stories.list',
		state: 'mounted-partial',
	},
	'activity.feed': {
		id: 'activity.feed',
		state: 'missing',
	},
	'operations.recovery': {
		id: 'operations.recovery',
		state: 'mounted-partial',
	},
	'usage.cost': {
		id: 'usage.cost',
		state: 'mounted-partial',
	},
	'exports.list': {
		id: 'exports.list',
		state: 'cli-or-package-only',
	},
	'settings.admin': {
		id: 'settings.admin',
		state: 'future-milestone',
	},
	'admin.members': {
		id: 'admin.members',
		state: 'mounted-partial',
	},
	'admin.policies': {
		id: 'admin.policies',
		state: 'future-milestone',
	},
	'admin.integrations': {
		id: 'admin.integrations',
		state: 'future-milestone',
	},
	'm10.provenance': {
		id: 'm10.provenance',
		state: 'future-milestone',
	},
} satisfies Record<CapabilityId, Capability>;

export function getCapability(id: CapabilityId) {
	return capabilities[id];
}

export function isCapabilityAvailable(id: CapabilityId) {
	const state = getCapability(id).state;
	return state === 'mounted-api' || state === 'mounted-partial';
}
