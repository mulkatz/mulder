import { AlertTriangle, CheckCircle2, FileUp, FolderPlus, RefreshCcw, ShieldCheck, Upload, Wand2 } from 'lucide-react';
import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import { StateNotice } from '@/components/StateNotice';
import { StatusBadge } from '@/components/StatusBadge';
import { Toolbar } from '@/components/Toolbar';
import { useSession } from '@/features/auth/useSession';
import { useCollections, useCreateCollection } from '@/features/collections/useCollections';
import {
	type DocumentUploadFailedStep,
	type DocumentUploadPayload,
	type DocumentUploadRetryMode,
	useDocumentUpload,
} from '@/features/documents/useDocumentUpload';
import { ApiError } from '@/lib/api-client';
import type {
	CollectionRecord,
	SensitivityLevel,
	UploadAcquisitionChannel,
	UploadAuthenticityStatus,
	UploadOriginalSourceType,
} from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';

const languages = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'uk', 'ru', 'ar', 'tr'] as const;
const channels: UploadAcquisitionChannel[] = [
	'manual_upload',
	'archive_import',
	'email_submission',
	'web_research',
	'api_import',
	'bulk_import',
	're_scan',
	'partner_exchange',
];
const authenticityStatuses: UploadAuthenticityStatus[] = ['unverified', 'verified', 'disputed'];
const sourceTypes: UploadOriginalSourceType[] = [
	'other',
	'correspondence',
	'field_notes',
	'measurement_data',
	'academic_paper',
	'government_document',
	'news_article',
	'witness_report',
	'photograph',
	'audio_recording',
	'video_recording',
];
const sensitivityLevels: SensitivityLevel[] = ['public', 'internal', 'restricted', 'confidential'];
const autoValue = '';

function Field({
	children,
	description,
	id,
	label,
	marker,
}: {
	children: ReactNode;
	description?: string;
	id?: string;
	label: string;
	marker?: ReactNode;
}) {
	return (
		<div className="block min-w-0">
			<div className="flex items-center gap-2">
				{id ? (
					<label className="text-sm font-medium text-text" htmlFor={id}>
						{label}
					</label>
				) : (
					<span className="text-sm font-medium text-text">{label}</span>
				)}
				{marker}
			</div>
			{description ? <span className="mt-0.5 block text-xs text-text-subtle">{description}</span> : null}
			<div className="mt-2">{children}</div>
		</div>
	);
}

function fieldClassName(className?: string) {
	return cn(
		'field w-full px-3 py-2 text-sm text-text outline-none transition-colors focus:border-border-strong',
		className,
	);
}

function formatBytes(value: number) {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function createClientId() {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now());
}

function collectionDefaultsText(collection: CollectionRecord | undefined, t: ReturnType<typeof useTranslation>['t']) {
	if (!collection) return undefined;
	return t('addSources.collectionDefaultsValue', {
		language: collection.defaults.default_language,
		sensitivity: t(`sensitivity.${collection.defaults.sensitivity_level}`),
	});
}

function uploadFailureText(
	failedStep: DocumentUploadFailedStep | undefined,
	t: ReturnType<typeof useTranslation>['t'],
) {
	if (!failedStep) return t('addSources.uploadFailed');
	return t(`addSources.uploadFailureSteps.${failedStep}`);
}

function uploadRetryLabel(retryMode: DocumentUploadRetryMode | undefined, t: ReturnType<typeof useTranslation>['t']) {
	if (retryMode === 'check_status') return t('addSources.checkStatusAgain');
	if (retryMode === 'open_processing') return t('addSources.openProcessing');
	return t('common.retry');
}

function processingJobLink(row: { jobId?: string; processingJobId?: string | null }) {
	return row.processingJobId ?? row.jobId;
}

function AiMarker({ label }: { label: string }) {
	return (
		<span className="rounded-sm border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
			{label}
		</span>
	);
}

export function AddSourcesPage() {
	const { t, i18n } = useTranslation();
	const sessionQuery = useSession();
	const collectionsQuery = useCollections({ limit: 100 });
	const createCollection = useCreateCollection();
	const upload = useDocumentUpload();
	const canManageCollections = ['owner', 'admin'].includes(sessionQuery.data?.data.user.role ?? '');
	const collections = collectionsQuery.data?.data ?? [];
	const [files, setFiles] = useState<File[]>([]);
	const [fileSelectionId, setFileSelectionId] = useState(createClientId);
	const [sourceLanguage, setSourceLanguage] = useState('');
	const [languageTouched, setLanguageTouched] = useState(false);
	const [channel, setChannel] = useState<UploadAcquisitionChannel | ''>('');
	const [acquisitionNotes, setAcquisitionNotes] = useState('');
	const [collectionId, setCollectionId] = useState('');
	const [noCollectionConfirmed, setNoCollectionConfirmed] = useState(false);
	const [sourceType, setSourceType] = useState<UploadOriginalSourceType | ''>('');
	const [sourceDescription, setSourceDescription] = useState('');
	const [authenticityStatus, setAuthenticityStatus] = useState<UploadAuthenticityStatus | ''>('');
	const [authenticityNotes, setAuthenticityNotes] = useState('');
	const [custodian, setCustodian] = useState('');
	const [custodyNotes, setCustodyNotes] = useState('');
	const [sensitivityLevel, setSensitivityLevel] = useState<SensitivityLevel | ''>('');
	const [sensitivityTouched, setSensitivityTouched] = useState(false);
	const [sensitivityReason, setSensitivityReason] = useState('');
	const [provenanceConfirmed, setProvenanceConfirmed] = useState(false);
	const [newCollectionName, setNewCollectionName] = useState('');
	const [newCollectionError, setNewCollectionError] = useState<string | undefined>();
	const [intakeSuggestionId, setIntakeSuggestionId] = useState<string | undefined>();
	const [aiSuggestedFields, setAiSuggestedFields] = useState<string[]>([]);
	const [autofillWarnings, setAutofillWarnings] = useState<string[]>([]);
	const [autofillError, setAutofillError] = useState<string | undefined>();
	const [autofillPending, setAutofillPending] = useState(false);
	const [autofillSkipped, setAutofillSkipped] = useState(false);

	const selectedCollection = collections.find((collection) => collection.collection_id === collectionId);
	const selectedDefaults = collectionDefaultsText(selectedCollection, t);
	const hasTerminalRows = upload.rows.some((row) =>
		['created', 'duplicate', 'completed_unavailable', 'failed', 'dead_letter'].includes(row.status),
	);
	const hasSuccessfulRows = upload.rows.some((row) => row.status === 'created' || row.status === 'duplicate');
	const selectedFileSize = useMemo(() => files.reduce((total, file) => total + file.size, 0), [files]);
	const collectionRequiredConfirmed = Boolean(collectionId) || noCollectionConfirmed;
	const formIsReady = files.length > 0 && collectionRequiredConfirmed && provenanceConfirmed;
	const isUploading = upload.rows.some((row) =>
		['initiating', 'uploading', 'finalizing', 'processing'].includes(row.status),
	);
	const canAutofill = files.length > 0 && !isUploading && !autofillPending;

	useEffect(() => {
		if (!selectedCollection) return;
		if (!languageTouched) {
			setSourceLanguage(selectedCollection.defaults.default_language);
		}
		if (!sensitivityTouched) {
			setSensitivityLevel(selectedCollection.defaults.sensitivity_level);
		}
	}, [languageTouched, selectedCollection, sensitivityTouched]);

	function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
		setFiles(Array.from(event.target.files ?? []));
		setFileSelectionId(createClientId());
		setIntakeSuggestionId(undefined);
		setAiSuggestedFields([]);
		setAutofillWarnings([]);
		setAutofillError(undefined);
		setAutofillSkipped(false);
		upload.reset();
	}

	function clearSuggestedField(field: string) {
		setAiSuggestedFields((current) => current.filter((candidate) => candidate !== field));
	}

	function suggestedMarker(field: string) {
		return aiSuggestedFields.includes(field) ? <AiMarker label={t('addSources.aiSuggested')} /> : undefined;
	}

	function buildPayload(): DocumentUploadPayload {
		const trimmedDescription = sourceDescription.trim();
		const trimmedCustodian = custodian.trim();
		const trimmedCustodyNotes = custodyNotes.trim();
		const trimmedAcquisitionNotes = acquisitionNotes.trim();
		const trimmedAuthenticityNotes = authenticityNotes.trim();
		const acquisition =
			channel || collectionId || trimmedAcquisitionNotes || noCollectionConfirmed
				? {
						...(channel ? { channel } : {}),
						collection_id: collectionId || null,
						metadata: {
							...(intakeSuggestionId ? { intake_suggestion_id: intakeSuggestionId } : {}),
							no_collection_confirmed: !collectionId && noCollectionConfirmed,
						},
						notes: trimmedAcquisitionNotes || null,
					}
				: intakeSuggestionId
					? {
							collection_id: collectionId || null,
							metadata: {
								intake_suggestion_id: intakeSuggestionId,
								no_collection_confirmed: !collectionId && noCollectionConfirmed,
							},
						}
					: undefined;
		const originalSource = trimmedDescription
			? {
					description: trimmedDescription,
					source_type: sourceType || 'other',
					...(sourceLanguage.trim() ? { language: sourceLanguage.trim() } : {}),
				}
			: undefined;
		const authenticity =
			authenticityStatus || trimmedAuthenticityNotes
				? {
						notes: trimmedAuthenticityNotes || null,
						status: authenticityStatus || 'unverified',
					}
				: undefined;
		const custodyChain = trimmedCustodian
			? [
					{
						holder: trimmedCustodian,
						holder_type: 'unknown' as const,
						notes: trimmedCustodyNotes || null,
						step_order: 1,
					},
				]
			: undefined;
		const payload: DocumentUploadPayload = {
			...(sensitivityLevel
				? {
						expected_sensitivity: {
							level: sensitivityLevel,
							...(sensitivityReason.trim() ? { reason: sensitivityReason.trim() } : {}),
						},
					}
				: {}),
			provenance: {
				...(acquisition ? { acquisition } : {}),
				...(authenticity ? { authenticity } : {}),
				...(custodyChain ? { custody_chain: custodyChain } : {}),
				...(originalSource ? { original_source: originalSource } : {}),
			},
		};
		return payload;
	}

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		if (!formIsReady || isUploading) return;
		await upload.uploadFiles(files, buildPayload());
	}

	async function handleAutofill() {
		const file = files[0];
		if (!file || !canAutofill) return;
		setAutofillPending(true);
		setAutofillError(undefined);
		setAutofillWarnings([]);
		setAutofillSkipped(false);
		try {
			const response = await upload.enrichProvenance(
				`autofill:${fileSelectionId}:0`,
				file,
				buildPayload(),
				collectionId || null,
			);
			const suggested = response.data.suggested;
			const appliedFields: string[] = [];
			const provenance = suggested.provenance;
			const originalSource = provenance?.original_source;
			const authenticity = provenance?.authenticity;
			const acquisition = provenance?.acquisition;
			if (originalSource?.language) {
				setSourceLanguage(originalSource.language);
				setLanguageTouched(true);
				appliedFields.push('language');
			}
			if (originalSource?.source_type) {
				setSourceType(originalSource.source_type);
				appliedFields.push('sourceType');
			}
			if (originalSource?.description) {
				setSourceDescription(originalSource.description);
				appliedFields.push('description');
			}
			if (authenticity?.status) {
				setAuthenticityStatus(authenticity.status);
				appliedFields.push('authenticityStatus');
			}
			if (authenticity?.notes) {
				setAuthenticityNotes(authenticity.notes);
				appliedFields.push('authenticityNotes');
			}
			if (acquisition?.channel) {
				setChannel(acquisition.channel);
				appliedFields.push('channel');
			}
			if (acquisition?.notes) {
				setAcquisitionNotes(acquisition.notes);
				appliedFields.push('acquisitionNotes');
			}
			if (suggested.expected_sensitivity?.level) {
				setSensitivityLevel(suggested.expected_sensitivity.level);
				setSensitivityTouched(true);
				appliedFields.push('sensitivity');
			}
			if (suggested.expected_sensitivity?.reason) {
				setSensitivityReason(suggested.expected_sensitivity.reason);
				appliedFields.push('sensitivityReason');
			}
			setIntakeSuggestionId(response.data.suggestion_id);
			setAiSuggestedFields(appliedFields);
			setAutofillWarnings(response.data.warnings);
		} catch (error) {
			setAutofillError(getErrorMessage(error, t('addSources.autofillFailed')));
		} finally {
			setAutofillPending(false);
		}
	}

	async function handleCreateCollection() {
		if (!newCollectionName.trim()) return;
		setNewCollectionError(undefined);
		try {
			const created = await createCollection.mutateAsync({
				defaults: {
					default_language: sourceLanguage || (i18n.language === 'de' ? 'de' : 'en'),
					sensitivity_level: sensitivityLevel || 'internal',
				},
				description: t('addSources.createdCollectionDescription'),
				name: newCollectionName.trim(),
				type: 'import_batch',
				visibility: 'private',
			});
			setCollectionId(created.data.collection_id);
			setNoCollectionConfirmed(false);
			setNewCollectionName('');
		} catch (error) {
			setNewCollectionError(
				error instanceof ApiError && error.status === 403
					? t('addSources.collectionCreateForbidden')
					: getErrorMessage(error, t('common.apiRequestFailed')),
			);
		}
	}

	return (
		<>
			<PageHeader
				actions={
					<Link
						className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
						to="/sources"
					>
						{t('addSources.backToSources')}
					</Link>
				}
				description={t('addSources.description')}
				eyebrow={t('addSources.eyebrow')}
				title={t('addSources.title')}
			/>

			<form className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_360px]" onSubmit={handleSubmit}>
				<section className="panel min-w-0 overflow-hidden">
					<Toolbar>
						<div className="flex items-center gap-2">
							<FileUp className="size-4 text-accent" />
							<h2 className="font-medium text-text">{t('addSources.filesTitle')}</h2>
						</div>
						<span className="ml-auto text-xs text-text-subtle">
							{files.length > 0
								? t('addSources.fileSummary', { count: files.length, size: formatBytes(selectedFileSize) })
								: t('addSources.noFilesSelected')}
						</span>
					</Toolbar>
					<div className="grid gap-5 p-4">
						<Field
							description={t('addSources.filesDescription')}
							id="add-sources-files"
							label={t('addSources.filesLabel')}
						>
							<input
								className={fieldClassName('cursor-pointer')}
								id="add-sources-files"
								multiple
								onChange={handleFileChange}
								type="file"
							/>
						</Field>
						<div className="rounded-md border border-border bg-panel-raised p-3">
							<div className="flex flex-wrap items-center gap-3">
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium text-text">{t('addSources.autofillStepTitle')}</p>
									<p className="mt-1 text-xs text-text-subtle">
										{files.length > 1 ? t('addSources.autofillHelpFirstFile') : t('addSources.autofillHelp')}
									</p>
								</div>
								<button
									className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field disabled:text-text-faint"
									disabled={!canAutofill}
									onClick={handleAutofill}
									type="button"
								>
									<Wand2 className="size-4" />
									{autofillPending ? t('addSources.autofilling') : t('addSources.acceptSuggestions')}
								</button>
								<button
									className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted transition-colors hover:bg-field hover:text-text"
									onClick={() => {
										setIntakeSuggestionId(undefined);
										setAiSuggestedFields([]);
										setAutofillError(undefined);
										setAutofillWarnings([]);
										setAutofillSkipped(true);
									}}
									disabled={files.length === 0 || autofillPending || autofillSkipped}
									type="button"
								>
									{autofillSkipped ? t('addSources.autofillSkipped') : t('addSources.continueWithoutSuggestions')}
								</button>
								{autofillSkipped ? (
									<span className="text-xs text-text-subtle">{t('addSources.autofillSkippedHelp')}</span>
								) : null}
							</div>
						</div>
						{autofillError ? <StateNotice tone="error" title={autofillError} /> : null}
						{autofillWarnings.length > 0 ? (
							<StateNotice tone="info" title={t('addSources.autofillReviewTitle')}>
								{autofillWarnings.join(' ')}
							</StateNotice>
						) : null}

						<div className="grid gap-4 md:grid-cols-2">
							<Field
								id="add-sources-language"
								label={t('addSources.sourceLanguage')}
								marker={suggestedMarker('language')}
							>
								<select
									className={fieldClassName()}
									id="add-sources-language"
									onChange={(event) => {
										setLanguageTouched(true);
										clearSuggestedField('language');
										setSourceLanguage(event.target.value);
									}}
									value={sourceLanguage}
								>
									<option value={autoValue}>{t('common.auto')}</option>
									{languages.map((language) => (
										<option key={language} value={language}>
											{t(`languages.${language}`, { defaultValue: language })}
										</option>
									))}
								</select>
							</Field>
							<Field
								id="add-sources-source-type"
								label={t('addSources.sourceType')}
								marker={suggestedMarker('sourceType')}
							>
								<select
									className={fieldClassName()}
									id="add-sources-source-type"
									onChange={(event) => {
										clearSuggestedField('sourceType');
										setSourceType(event.target.value as UploadOriginalSourceType | '');
									}}
									value={sourceType}
								>
									<option value={autoValue}>{t('common.auto')}</option>
									{sourceTypes.map((type) => (
										<option key={type} value={type}>
											{t(`sourceTypes.${type}`)}
										</option>
									))}
								</select>
							</Field>
						</div>

						<Field
							description={t('addSources.sourceDescriptionHelp')}
							id="add-sources-description"
							label={t('addSources.sourceDescription')}
							marker={suggestedMarker('description')}
						>
							<textarea
								className={fieldClassName('min-h-24 resize-y')}
								id="add-sources-description"
								onChange={(event) => {
									clearSuggestedField('description');
									setSourceDescription(event.target.value);
								}}
								value={sourceDescription}
							/>
						</Field>

						<div className="grid gap-4 md:grid-cols-2">
							<Field
								id="add-sources-acquisition-channel"
								label={t('addSources.acquisitionChannel')}
								marker={suggestedMarker('channel')}
							>
								<select
									className={fieldClassName()}
									id="add-sources-acquisition-channel"
									onChange={(event) => {
										clearSuggestedField('channel');
										setChannel(event.target.value as UploadAcquisitionChannel | '');
									}}
									value={channel}
								>
									<option value={autoValue}>{t('common.auto')}</option>
									{channels.map((item) => (
										<option key={item} value={item}>
											{t(`acquisitionChannels.${item}`)}
										</option>
									))}
								</select>
							</Field>
							<Field
								id="add-sources-authenticity-status"
								label={t('addSources.authenticityStatus')}
								marker={suggestedMarker('authenticityStatus')}
							>
								<select
									className={fieldClassName()}
									id="add-sources-authenticity-status"
									onChange={(event) => {
										clearSuggestedField('authenticityStatus');
										setAuthenticityStatus(event.target.value as UploadAuthenticityStatus | '');
									}}
									value={authenticityStatus}
								>
									<option value={autoValue}>{t('common.auto')}</option>
									{authenticityStatuses.map((status) => (
										<option key={status} value={status}>
											{t(`authenticity.${status}`)}
										</option>
									))}
								</select>
							</Field>
						</div>

						<div className="grid gap-4 md:grid-cols-2">
							<Field
								id="add-sources-acquisition-notes"
								label={t('addSources.acquisitionNotes')}
								marker={suggestedMarker('acquisitionNotes')}
							>
								<textarea
									className={fieldClassName('min-h-24 resize-y')}
									id="add-sources-acquisition-notes"
									onChange={(event) => {
										clearSuggestedField('acquisitionNotes');
										setAcquisitionNotes(event.target.value);
									}}
									value={acquisitionNotes}
								/>
							</Field>
							<Field
								id="add-sources-authenticity-notes"
								label={t('addSources.authenticityNotes')}
								marker={suggestedMarker('authenticityNotes')}
							>
								<textarea
									className={fieldClassName('min-h-24 resize-y')}
									id="add-sources-authenticity-notes"
									onChange={(event) => {
										clearSuggestedField('authenticityNotes');
										setAuthenticityNotes(event.target.value);
									}}
									value={authenticityNotes}
								/>
							</Field>
						</div>

						<div className="grid gap-4 md:grid-cols-2">
							<Field id="add-sources-custodian" label={t('addSources.currentCustodian')}>
								<input
									className={fieldClassName()}
									id="add-sources-custodian"
									onChange={(event) => setCustodian(event.target.value)}
									value={custodian}
								/>
							</Field>
							<Field id="add-sources-custody-notes" label={t('addSources.custodyNotes')}>
								<input
									className={fieldClassName()}
									id="add-sources-custody-notes"
									onChange={(event) => setCustodyNotes(event.target.value)}
									value={custodyNotes}
								/>
							</Field>
						</div>

						<div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
							<Field
								id="add-sources-sensitivity-level"
								label={t('addSources.sensitivityLevel')}
								marker={suggestedMarker('sensitivity')}
							>
								<select
									className={fieldClassName()}
									id="add-sources-sensitivity-level"
									onChange={(event) => {
										setSensitivityTouched(true);
										clearSuggestedField('sensitivity');
										setSensitivityLevel(event.target.value as SensitivityLevel | '');
									}}
									value={sensitivityLevel}
								>
									<option value={autoValue}>{t('common.auto')}</option>
									{sensitivityLevels.map((level) => (
										<option key={level} value={level}>
											{t(`sensitivity.${level}`)}
										</option>
									))}
								</select>
							</Field>
							<Field
								id="add-sources-sensitivity-reason"
								label={t('addSources.sensitivityReason')}
								marker={suggestedMarker('sensitivityReason')}
							>
								<input
									className={fieldClassName()}
									id="add-sources-sensitivity-reason"
									onChange={(event) => {
										clearSuggestedField('sensitivityReason');
										setSensitivityReason(event.target.value);
									}}
									value={sensitivityReason}
								/>
							</Field>
						</div>
					</div>
				</section>

				<aside className="space-y-4">
					<section className="panel overflow-hidden">
						<Toolbar>
							<div className="flex items-center gap-2">
								<ShieldCheck className="size-4 text-accent" />
								<h2 className="font-medium text-text">{t('addSources.collectionTitle')}</h2>
							</div>
						</Toolbar>
						<div className="space-y-4 p-4">
							{collectionsQuery.isLoading ? (
								<StateNotice tone="loading" title={t('addSources.collectionsLoading')} />
							) : null}
							{collectionsQuery.error ? (
								<StateNotice
									tone="error"
									title={
										isApiUnavailableError(collectionsQuery.error)
											? t('addSources.collectionsUnavailable')
											: t('addSources.collectionsError')
									}
								>
									{getErrorMessage(collectionsQuery.error, t('common.apiRequestFailed'))}
								</StateNotice>
							) : null}
							<Field id="add-sources-collection" label={t('addSources.collectionSelect')}>
								<select
									className={fieldClassName()}
									id="add-sources-collection"
									onChange={(event) => {
										setCollectionId(event.target.value);
										if (event.target.value) setNoCollectionConfirmed(false);
									}}
									value={collectionId}
								>
									<option value="">{t('addSources.noCollectionOption')}</option>
									{collections.map((collection) => (
										<option key={collection.collection_id} value={collection.collection_id}>
											{collection.name}
										</option>
									))}
								</select>
							</Field>
							{selectedDefaults ? (
								<p className="rounded-md border border-border bg-panel-raised p-3 text-xs text-text-muted">
									{selectedDefaults}
								</p>
							) : null}
							{!collectionId ? (
								<label className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning-soft p-3 text-sm text-warning">
									<input
										checked={noCollectionConfirmed}
										className="mt-1"
										id="add-sources-no-collection-confirmed"
										onChange={(event) => setNoCollectionConfirmed(event.target.checked)}
										type="checkbox"
									/>
									<span>{t('addSources.noCollectionWarning')}</span>
								</label>
							) : null}
							{canManageCollections ? (
								<div className="rounded-md border border-border bg-panel-raised p-3">
									<div className="flex items-center gap-2 text-sm font-medium text-text">
										<FolderPlus className="size-4 text-accent" />
										{t('addSources.createCollectionTitle')}
									</div>
									<div className="mt-3 flex gap-2">
										<input
											aria-label={t('addSources.collectionNamePlaceholder')}
											className={fieldClassName()}
											onChange={(event) => setNewCollectionName(event.target.value)}
											placeholder={t('addSources.collectionNamePlaceholder')}
											value={newCollectionName}
										/>
										<button
											className="inline-flex h-9 shrink-0 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field disabled:text-text-faint"
											disabled={!newCollectionName.trim() || createCollection.isPending}
											onClick={handleCreateCollection}
											type="button"
										>
											{t('common.add')}
										</button>
									</div>
									{newCollectionError ? <p className="mt-2 text-xs text-danger">{newCollectionError}</p> : null}
								</div>
							) : (
								<p className="text-xs text-text-subtle">{t('addSources.collectionCreateUnavailable')}</p>
							)}
						</div>
					</section>

					<section className="panel overflow-hidden">
						<Toolbar>
							<div className="flex items-center gap-2">
								<AlertTriangle className="size-4 text-accent" />
								<h2 className="font-medium text-text">{t('addSources.confirmationTitle')}</h2>
							</div>
						</Toolbar>
						<div className="space-y-4 p-4">
							<label className="flex items-start gap-2 text-sm text-text-muted">
								<input
									checked={provenanceConfirmed}
									className="mt-1"
									id="add-sources-provenance-confirmed"
									onChange={(event) => setProvenanceConfirmed(event.target.checked)}
									type="checkbox"
								/>
								<span>{t('addSources.provenanceConfirmation')}</span>
							</label>
							<button
								className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover disabled:bg-field disabled:text-text-faint"
								disabled={!formIsReady || isUploading}
								type="submit"
							>
								<Upload className="size-4" />
								{isUploading ? t('addSources.uploading') : t('addSources.startUpload')}
							</button>
							{hasSuccessfulRows ? (
								<Link
									className="inline-flex h-9 w-full items-center justify-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
									to="/sources/add"
									onClick={() => {
										setFiles([]);
										upload.reset();
									}}
								>
									{t('addSources.addAnotherBatch')}
								</Link>
							) : null}
						</div>
					</section>
				</aside>

				<section className="panel min-w-0 overflow-hidden xl:col-span-2">
					<Toolbar>
						<div className="flex items-center gap-2">
							<CheckCircle2 className="size-4 text-accent" />
							<h2 className="font-medium text-text">{t('addSources.progressTitle')}</h2>
						</div>
						{hasTerminalRows ? (
							<span className="ml-auto text-xs text-text-subtle">{t('addSources.progressDone')}</span>
						) : null}
					</Toolbar>
					<div className="overflow-x-auto">
						<table className="w-full min-w-[820px] border-collapse text-sm">
							<thead>
								<tr className="border-b border-border bg-panel-raised text-left text-xs text-text-subtle">
									<th className="px-3 py-2 font-medium">{t('addSources.tableFile')}</th>
									<th className="px-3 py-2 font-medium">{t('addSources.tableSize')}</th>
									<th className="px-3 py-2 font-medium">{t('common.status')}</th>
									<th className="px-3 py-2 font-medium">{t('addSources.tableResult')}</th>
									<th className="px-3 py-2 font-medium">{t('addSources.tableAction')}</th>
								</tr>
							</thead>
							<tbody>
								{upload.rows.length === 0 ? (
									<tr>
										<td className="px-3 py-8 text-center text-text-subtle" colSpan={5}>
											{t('addSources.progressEmpty')}
										</td>
									</tr>
								) : null}
								{upload.rows.map((row) => (
									<tr className="border-b border-border last:border-b-0" key={row.id}>
										<td className="max-w-[340px] px-3 py-3">
											<p className="truncate font-medium text-text">{row.file.name}</p>
											{row.failedStep ? (
												<p className="mt-1 text-xs font-medium text-danger">{uploadFailureText(row.failedStep, t)}</p>
											) : null}
											{row.error ? <p className="mt-1 text-xs text-text-subtle">{row.error}</p> : null}
										</td>
										<td className="px-3 py-3 font-mono text-xs text-text-muted">{formatBytes(row.file.size)}</td>
										<td className="px-3 py-3">
											<StatusBadge status={row.status} />
										</td>
										<td className="px-3 py-3 text-text-muted">
											{row.status === 'completed_unavailable'
												? t('addSources.completedUnavailable')
												: (row.source?.filename ?? t('common.notExposed'))}
										</td>
										<td className="px-3 py-3">
											{(row.status === 'created' || row.status === 'duplicate') && row.source ? (
												<Link
													className="text-sm font-medium text-accent hover:underline"
													to={`/sources/${row.source.id}`}
												>
													{t('addSources.openSource')}
												</Link>
											) : null}
											{(row.status === 'created' || row.status === 'duplicate') && row.processingJobId ? (
												<Link
													className="ml-3 text-sm font-medium text-accent hover:underline"
													to={`/runs?job=${row.processingJobId}`}
												>
													{t('addSources.openProcessing')}
												</Link>
											) : null}
											{row.retryMode === 'open_processing' && processingJobLink(row) ? (
												<Link
													className="inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
													to={`/runs?job=${processingJobLink(row)}`}
												>
													{uploadRetryLabel(row.retryMode, t)}
												</Link>
											) : null}
											{(row.status === 'failed' || row.status === 'dead_letter') &&
											row.retryMode !== 'open_processing' ? (
												<button
													className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
													disabled={isUploading || !formIsReady}
													onClick={() => void upload.retryRow(row.id, buildPayload())}
													type="button"
												>
													<RefreshCcw className="size-3.5" />
													{uploadRetryLabel(row.retryMode, t)}
												</button>
											) : null}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			</form>
		</>
	);
}
