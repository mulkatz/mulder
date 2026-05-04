import type { TFunction } from 'i18next';
import { ChevronDown, ExternalLink, Filter, Link2, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DataColumn, DataTable } from '@/components/DataTable';
import { IconButton } from '@/components/IconButton';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput } from '@/components/SearchInput';
import { StateNotice } from '@/components/StateNotice';
import { StatusBadge } from '@/components/StatusBadge';
import { Tabs } from '@/components/Tabs';
import { SelectControl, Toolbar } from '@/components/Toolbar';
import { useContradictions } from '@/features/evidence/useContradictions';
import { useEvidenceSummary } from '@/features/evidence/useEvidenceSummary';
import { getErrorMessage } from '@/lib/query-state';
import type { ClaimStatus, EvidenceClaim, SourceRef } from '@/lib/types';
import { contradictionToClaim } from '@/lib/view-models';

function getClaimColumns(t: TFunction): DataColumn<EvidenceClaim>[] {
	return [
		{
			key: 'claim',
			header: t('evidence.tableEvidenceItem'),
			render: (claim) => (
				<div className="min-w-0">
					<p className="max-w-2xl truncate font-medium text-text">{claim.claim}</p>
				</div>
			),
		},
		{
			key: 'entity',
			header: t('evidence.tableEntity'),
			className: 'w-44',
			render: (claim) => <span className="text-text-muted">{claim.entity}</span>,
		},
		{
			key: 'status',
			header: t('common.status'),
			className: 'w-36',
			render: (claim) => <StatusBadge status={claim.status} />,
		},
		{
			key: 'confidence',
			header: t('evidence.tableConfidence'),
			className: 'w-36',
			render: (claim) => (
				<div className="flex items-center gap-3">
					<div className="h-1.5 w-20 overflow-hidden rounded-xs bg-field">
						<div className="h-full rounded-xs bg-accent" style={{ width: `${Math.round(claim.confidence * 100)}%` }} />
					</div>
					<span className="font-mono text-xs text-text-muted">{Math.round(claim.confidence * 100)}%</span>
				</div>
			),
		},
		{
			key: 'sources',
			header: t('evidence.tableSources'),
			className: 'w-24',
			render: (claim) => <span className="font-mono">{claim.sourceCount}</span>,
		},
		{
			key: 'lastSeen',
			header: t('evidence.tableLastSeen'),
			className: 'w-36',
			render: (claim) => <span className="font-mono text-xs">{claim.lastSeen}</span>,
		},
	];
}

function getCitationColumns(t: TFunction): DataColumn<SourceRef>[] {
	return [
		{
			key: 'title',
			header: t('common.source'),
			render: (source) => (
				<div className="min-w-0">
					<p className="truncate font-medium text-text">{source.title}</p>
					<p className="mt-1 font-mono text-xs text-text-subtle">{source.id}</p>
				</div>
			),
		},
		{
			key: 'type',
			header: t('common.type'),
			className: 'w-28',
			render: (source) => <span className="text-text-muted">{source.type}</span>,
		},
		{
			key: 'locator',
			header: t('common.locator'),
			className: 'w-24',
			render: (source) => <span className="font-mono text-xs">{source.locator}</span>,
		},
		{
			key: 'reliability',
			header: t('evidence.reliability'),
			className: 'w-28',
			render: (source) => <span className="font-mono text-xs">{Math.round(source.reliability * 100)}%</span>,
		},
	];
}

export function EvidenceWorkspacePage() {
	const { t, i18n } = useTranslation();
	const [status, setStatus] = useState<ClaimStatus | 'all'>('all');
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const evidenceSummaryQuery = useEvidenceSummary();
	const contradictionsQuery = useContradictions({ limit: 50 });
	const viewModelContext = useMemo(() => ({ locale: i18n.language, t }), [i18n.language, t]);
	const evidenceClaims = useMemo(
		() => (contradictionsQuery.data?.data ?? []).map((record) => contradictionToClaim(record, viewModelContext)),
		[contradictionsQuery.data, viewModelContext],
	);
	const tabs = useMemo(
		() => [
			{ value: 'all', label: t('common.all'), count: evidenceClaims.length },
			{
				value: 'contradicted',
				label: t('evidence.tabContradicted'),
				count: evidenceClaims.filter((claim) => claim.status === 'contradicted').length,
			},
			{
				value: 'watching',
				label: t('evidence.tabWatching'),
				count: evidenceClaims.filter((claim) => claim.status === 'watching').length,
			},
			{
				value: 'unverified',
				label: t('evidence.tabUnverified'),
				count: evidenceClaims.filter((claim) => claim.status === 'unverified').length,
			},
		],
		[evidenceClaims, t],
	);

	const filteredClaims = useMemo(() => {
		return evidenceClaims.filter((claim) => {
			const statusMatch = status === 'all' || claim.status === status;
			const queryMatch = `${claim.claim} ${claim.entity} ${claim.id}`.toLowerCase().includes(query.toLowerCase());
			return statusMatch && queryMatch;
		});
	}, [evidenceClaims, query, status]);

	const selectedClaim = filteredClaims.find((claim) => claim.id === selectedId) ?? filteredClaims[0];
	const summary = evidenceSummaryQuery.data?.data;
	const claimColumns = getClaimColumns(t);
	const citationColumns = getCitationColumns(t);

	return (
		<>
			<PageHeader
				actions={
					<button
						className="inline-flex h-9 items-center gap-2 rounded-md bg-field px-3 text-sm font-medium text-text-subtle"
						disabled
						title={t('evidence.reviewQueueTitle')}
						type="button"
					>
						<ShieldAlert className="size-4" />
						{t('evidence.reviewQueue')}
					</button>
				}
				description={t('evidence.description')}
				eyebrow={t('evidence.eyebrow')}
				title={t('evidence.title')}
			/>

			<div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<section className="panel min-w-0 overflow-hidden">
					{contradictionsQuery.isLoading || evidenceSummaryQuery.isLoading ? (
						<div className="border-b border-border p-3">
							<StateNotice tone="loading" title={t('evidence.loadingTitle')} />
						</div>
					) : null}
					{contradictionsQuery.error || evidenceSummaryQuery.error ? (
						<div className="border-b border-border p-3">
							<StateNotice tone="error" title={t('evidence.errorTitle')}>
								{getErrorMessage(contradictionsQuery.error ?? evidenceSummaryQuery.error, t('common.apiRequestFailed'))}
							</StateNotice>
						</div>
					) : null}
					<Toolbar className="gap-3">
						<SearchInput
							className="w-full sm:max-w-sm"
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t('evidence.filterPlaceholder')}
							value={query}
						/>
						<SelectControl disabled label={t('common.source')} title={t('evidence.sourceFilterTitle')}>
							{t('common.any')}
							<ChevronDown className="size-3.5 text-text-subtle" />
						</SelectControl>
						<SelectControl disabled label={t('evidence.reliability')} title={t('evidence.reliabilityFilterTitle')}>
							{t('evidence.reliabilityThreshold')}
							<ChevronDown className="size-3.5 text-text-subtle" />
						</SelectControl>
						<IconButton disabled label={t('common.advancedFilters')} title={t('evidence.advancedFiltersTitle')}>
							<Filter className="size-4" />
						</IconButton>
					</Toolbar>

					<div className="border-b border-border p-3">
						<Tabs onChange={(value) => setStatus(value as ClaimStatus | 'all')} tabs={tabs} value={status} />
					</div>

					<DataTable
						columns={claimColumns}
						emptyMessage={
							contradictionsQuery.isSuccess ? t('evidence.noMatchingRecords') : t('evidence.noRecordsLoaded')
						}
						getRowKey={(claim) => claim.id}
						minWidth={760}
						onRowClick={(claim) => setSelectedId(claim.id)}
						rows={filteredClaims}
						selectedKey={selectedClaim?.id}
					/>
				</section>

				{selectedClaim ? (
					<InspectorPanel subtitle={selectedClaim.id} title={selectedClaim.entity}>
						<InspectorSection title={t('evidence.evidenceItem')}>
							<p className="text-sm text-text">{selectedClaim.claim}</p>
							<div className="mt-3 flex flex-wrap gap-2">
								<StatusBadge status={selectedClaim.status} />
								<span className="inline-flex h-6 items-center rounded-sm border border-border bg-field px-2 font-mono text-[11px] text-text-muted">
									{t('evidence.confidenceValue', { value: Math.round(selectedClaim.confidence * 100) })}
								</span>
							</div>
						</InspectorSection>

						<InspectorSection title={t('evidence.signals')}>
							<div className="flex flex-wrap gap-2">
								{selectedClaim.signals.map((signal) => (
									<span
										className="rounded-sm border border-border bg-panel-raised px-2 py-1 text-xs text-text-muted"
										key={signal}
									>
										{signal}
									</span>
								))}
							</div>
						</InspectorSection>

						<InspectorSection title={t('evidence.citations')}>
							{selectedClaim.citations.length > 0 ? (
								<div className="-mx-4">
									<DataTable
										columns={citationColumns}
										getRowKey={(source) => source.id}
										minWidth={520}
										rows={selectedClaim.citations}
									/>
								</div>
							) : (
								<StateNotice title={t('evidence.citationsMissingTitle')}>
									{t('capabilities.evidence_claims')}
								</StateNotice>
							)}
						</InspectorSection>

						<InspectorSection title={t('evidence.sourceDetail')}>
							{selectedClaim.citations.length > 0 ? (
								<div className="space-y-2">
									{selectedClaim.citations.map((source) => (
										<div
											className="rounded-md border border-border bg-panel-raised p-3"
											key={`${selectedClaim.id}-${source.id}`}
										>
											<div className="flex items-start justify-between gap-3">
												<div className="min-w-0">
													<p className="truncate text-sm font-medium text-text">{source.title}</p>
													<p className="mt-1 font-mono text-xs text-text-subtle">
														{source.date} · {source.locator}
													</p>
												</div>
												<IconButton className="size-7" label={t('evidence.openSource', { title: source.title })}>
													<ExternalLink className="size-3.5" />
												</IconButton>
											</div>
											<div className="mt-3 flex items-center gap-2 text-xs text-text-muted">
												<Link2 className="size-3.5 text-accent" />
												<span>{t('evidence.sourceReliability', { value: Math.round(source.reliability * 100) })}</span>
											</div>
										</div>
									))}
								</div>
							) : (
								<div className="grid grid-cols-2 gap-2">
									<div className="rounded-md bg-field p-3">
										<p className="text-xs text-text-subtle">{t('evidence.sourcesScored')}</p>
										<p className="mt-2 font-mono text-sm text-text">{summary?.sources.scored ?? '—'}</p>
									</div>
									<div className="rounded-md bg-field p-3">
										<p className="text-xs text-text-subtle">{t('evidence.reliability')}</p>
										<p className="mt-2 font-mono text-sm text-text">{summary?.sources.data_reliability ?? '—'}</p>
									</div>
								</div>
							)}
						</InspectorSection>
					</InspectorPanel>
				) : (
					<InspectorPanel title={t('evidence.noEvidenceSelected')}>
						<StateNotice title={t('evidence.noContradictionsLoaded')}>{t('evidence.noContradictionsBody')}</StateNotice>
					</InspectorPanel>
				)}
			</div>
		</>
	);
}
