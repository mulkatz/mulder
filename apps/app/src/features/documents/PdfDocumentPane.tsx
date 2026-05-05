import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { IconButton } from '@/components/IconButton';
import { StateNotice } from '@/components/StateNotice';
import { useDocumentPdf } from '@/features/documents/useDocumentPdf';
import { cn } from '@/lib/cn';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function readPageStart(pageStart: number | null | undefined) {
	return typeof pageStart === 'number' && Number.isFinite(pageStart) && pageStart > 0 ? Math.floor(pageStart) : 1;
}

function useElementWidth() {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);

	useEffect(() => {
		if (!element) return;

		const updateWidth = () => setWidth(element.clientWidth);
		updateWidth();

		const observer = new ResizeObserver(updateWidth);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);

	return [setElement, width] as const;
}

function PdfNotice({
	children,
	onRetry,
	testId,
	title,
	tone = 'error',
}: {
	children?: ReactNode;
	onRetry?: () => void;
	testId?: string;
	title: string;
	tone?: 'error' | 'loading';
}) {
	const { t } = useTranslation();

	return (
		<div className="p-3" data-testid={testId}>
			<StateNotice tone={tone} title={title}>
				{children ? <p>{children}</p> : null}
				{onRetry ? (
					<button
						className="mt-3 inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
						onClick={onRetry}
						type="button"
					>
						{t('common.retry')}
					</button>
				) : null}
			</StateNotice>
		</div>
	);
}

export function PdfDocumentPane({
	className,
	sourceId,
	storyStartPage,
}: {
	className?: string;
	sourceId: string;
	storyStartPage?: number | null;
}) {
	const { t } = useTranslation();
	const pdfQuery = useDocumentPdf(sourceId);
	const [containerRef, containerWidth] = useElementWidth();
	const [blobUrl, setBlobUrl] = useState<string | undefined>();
	const [numPages, setNumPages] = useState<number | undefined>();
	const [pageNumber, setPageNumber] = useState(readPageStart(storyStartPage));
	const [zoom, setZoom] = useState(1);
	const [renderKey, setRenderKey] = useState(0);
	const targetStoryPage = readPageStart(storyStartPage);
	const pageWidth = Math.max(240, containerWidth - 32) * zoom;
	const pageStatus =
		typeof numPages === 'number'
			? t('reader.pdfPageStatus', { page: pageNumber, total: numPages })
			: t('reader.pdfPageStatusPending', { page: pageNumber });
	const zoomValue = t('reader.pdfZoomValue', { value: Math.round(zoom * 100) });
	const canGoPrevious = pageNumber > 1;
	const canGoNext = typeof numPages === 'number' && pageNumber < numPages;
	const canZoomOut = zoom > MIN_ZOOM;
	const canZoomIn = zoom < MAX_ZOOM;

	useEffect(() => {
		if (!pdfQuery.data) {
			setBlobUrl(undefined);
			return;
		}

		const url = URL.createObjectURL(pdfQuery.data);
		setBlobUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [pdfQuery.data]);

	useEffect(() => {
		setPageNumber(typeof numPages === 'number' ? clamp(targetStoryPage, 1, numPages) : targetStoryPage);
	}, [targetStoryPage, numPages]);

	function handleLoadSuccess({ numPages: loadedPages }: { numPages: number }) {
		setNumPages(loadedPages);
		setPageNumber((current) => clamp(current, 1, loadedPages));
	}

	function handleRetry() {
		setRenderKey((current) => current + 1);
		void pdfQuery.refetch();
	}

	function goToPreviousPage() {
		setPageNumber((current) => clamp(current - 1, 1, numPages ?? current));
	}

	function goToNextPage() {
		setPageNumber((current) => clamp(current + 1, 1, numPages ?? current + 1));
	}

	function zoomOut() {
		setZoom((current) => clamp(current - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
	}

	function zoomIn() {
		setZoom((current) => clamp(current + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
	}

	if (!blobUrl && pdfQuery.error) {
		return (
			<div className={cn('h-full min-h-[420px] bg-panel-raised', className)} data-testid="pdf-document-pane">
				<PdfNotice
					onRetry={handleRetry}
					testId="pdf-document-error"
					title={isApiUnavailableError(pdfQuery.error) ? t('reader.pdfUnavailableTitle') : t('reader.pdfErrorTitle')}
				>
					{getErrorMessage(pdfQuery.error, t('common.apiRequestFailed'))}
				</PdfNotice>
			</div>
		);
	}

	if (!blobUrl) {
		return (
			<div className={cn('h-full min-h-[420px] bg-panel-raised', className)} data-testid="pdf-document-pane">
				<PdfNotice testId="pdf-document-loading" title={t('reader.pdfLoadingTitle')} tone="loading">
					{t('reader.pdfLoadingBody')}
				</PdfNotice>
			</div>
		);
	}

	return (
		<div
			className={cn('flex h-full min-h-[420px] flex-col bg-panel-raised', className)}
			data-testid="pdf-document-pane"
		>
			<div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2">
				<div className="flex items-center gap-1">
					<IconButton
						disabled={!canGoPrevious}
						label={t('reader.pdfPreviousPage')}
						onClick={goToPreviousPage}
						title={t('reader.pdfPreviousPage')}
					>
						<ChevronLeft className="size-4" />
					</IconButton>
					<IconButton
						disabled={!canGoNext}
						label={t('reader.pdfNextPage')}
						onClick={goToNextPage}
						title={t('reader.pdfNextPage')}
					>
						<ChevronRight className="size-4" />
					</IconButton>
				</div>
				<span aria-live="polite" className="mono-tabular text-sm text-text-muted">
					{pageStatus}
				</span>
				<div className="ml-auto flex items-center gap-1">
					<IconButton
						disabled={!canZoomOut}
						label={t('reader.pdfZoomOut')}
						onClick={zoomOut}
						title={t('reader.pdfZoomOut')}
					>
						<ZoomOut className="size-4" />
					</IconButton>
					<span className="mono-tabular min-w-12 text-center text-sm text-text-muted">{zoomValue}</span>
					<IconButton
						disabled={!canZoomIn}
						label={t('reader.pdfZoomIn')}
						onClick={zoomIn}
						title={t('reader.pdfZoomIn')}
					>
						<ZoomIn className="size-4" />
					</IconButton>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-auto bg-field p-4" ref={containerRef}>
				<Document
					error={
						<PdfNotice onRetry={handleRetry} testId="pdf-document-error" title={t('reader.pdfRenderErrorTitle')}>
							{t('reader.pdfRenderErrorBody')}
						</PdfNotice>
					}
					file={blobUrl}
					key={`${blobUrl}-${renderKey}`}
					loading={<PdfNotice testId="pdf-document-loading" title={t('reader.pdfPreparingTitle')} tone="loading" />}
					onLoadSuccess={handleLoadSuccess}
				>
					{containerWidth > 0 ? (
						<div className="mx-auto w-fit overflow-hidden rounded-sm border border-border bg-panel shadow-soft">
							<Page
								error={
									<PdfNotice onRetry={handleRetry} testId="pdf-render-error" title={t('reader.pdfRenderErrorTitle')}>
										{t('reader.pdfRenderErrorBody')}
									</PdfNotice>
								}
								loading={
									<PdfNotice testId="pdf-document-loading" title={t('reader.pdfPreparingTitle')} tone="loading" />
								}
								pageNumber={pageNumber}
								width={pageWidth}
							/>
						</div>
					) : null}
				</Document>
			</div>
		</div>
	);
}
