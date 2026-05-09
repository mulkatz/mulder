import { AnimatePresence } from 'framer-motion';
import { Component, lazy, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';
import { AuthGate } from '@/app/AuthGate';
import { AppShell } from '@/components/AppShell';
import { PageTransition } from '@/components/PageTransition';
import { StateNotice } from '@/components/StateNotice';

const AcceptInvitationPage = lazy(() =>
	import('@/pages/AcceptInvitation').then((module) => ({ default: module.AcceptInvitationPage })),
);
const AnalysisRunsPage = lazy(() =>
	import('@/pages/AnalysisRuns').then((module) => ({ default: module.AnalysisRunsPage })),
);
const EvidenceWorkspacePage = lazy(() =>
	import('@/pages/EvidenceWorkspace').then((module) => ({ default: module.EvidenceWorkspacePage })),
);
const LoginPage = lazy(() => import('@/pages/Login').then((module) => ({ default: module.LoginPage })));
const OverviewPage = lazy(() => import('@/pages/Overview').then((module) => ({ default: module.OverviewPage })));
const SourceReaderPage = lazy(() =>
	import('@/pages/SourceReader').then((module) => ({ default: module.SourceReaderPage })),
);
const SourcesPage = lazy(() => import('@/pages/Sources').then((module) => ({ default: module.SourcesPage })));

type RouteErrorBoundaryProps = {
	children: ReactNode;
	fallback: ReactNode;
	resetKey: string;
};

type RouteErrorBoundaryState = {
	hasError: boolean;
	resetKey: string;
};

class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
	state: RouteErrorBoundaryState = {
		hasError: false,
		resetKey: this.props.resetKey,
	};

	static getDerivedStateFromError(): Partial<RouteErrorBoundaryState> {
		return { hasError: true };
	}

	static getDerivedStateFromProps(
		props: RouteErrorBoundaryProps,
		state: RouteErrorBoundaryState,
	): Partial<RouteErrorBoundaryState> | null {
		if (props.resetKey !== state.resetKey) {
			return { hasError: false, resetKey: props.resetKey };
		}

		return null;
	}

	render() {
		if (this.state.hasError) {
			return this.props.fallback;
		}

		return this.props.children;
	}
}

function RouteLoadingNotice() {
	const { t } = useTranslation();

	return (
		<div className="mx-auto mt-10 w-full max-w-sm px-4">
			<StateNotice tone="loading" title={t('common.loading')} />
		</div>
	);
}

function RouteLoadErrorNotice() {
	const { t } = useTranslation();

	return (
		<div className="mx-auto mt-10 w-full max-w-sm px-4">
			<StateNotice tone="error" title={t('common.routeLoadErrorTitle')}>
				<p>{t('common.routeLoadErrorBody')}</p>
				<button
					className="mt-3 inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
					onClick={() => window.location.reload()}
					type="button"
				>
					{t('common.refresh')}
				</button>
			</StateNotice>
		</div>
	);
}

function withPageTransition(page: ReactNode, resetKey: string) {
	return (
		<PageTransition>
			<RouteErrorBoundary fallback={<RouteLoadErrorNotice />} resetKey={resetKey}>
				<Suspense fallback={<RouteLoadingNotice />}>{page}</Suspense>
			</RouteErrorBoundary>
		</PageTransition>
	);
}

function AppRoutes() {
	const location = useLocation();

	return (
		<AnimatePresence mode="wait">
			<Routes location={location} key={location.pathname}>
				<Route path="/login" element={withPageTransition(<LoginPage />, location.pathname)} />
				<Route
					path="/auth/invitations/:token"
					element={withPageTransition(<AcceptInvitationPage />, location.pathname)}
				/>
				<Route element={<AuthGate />}>
					<Route element={<AppShell />}>
						<Route index element={withPageTransition(<OverviewPage />, location.pathname)} />
						<Route path="/runs" element={withPageTransition(<AnalysisRunsPage />, location.pathname)} />
						<Route path="/evidence" element={withPageTransition(<EvidenceWorkspacePage />, location.pathname)} />
						<Route path="/sources" element={withPageTransition(<SourcesPage />, location.pathname)} />
						<Route path="/sources/:sourceId" element={withPageTransition(<SourceReaderPage />, location.pathname)} />
					</Route>
				</Route>
				<Route path="*" element={<Navigate replace to="/" />} />
			</Routes>
		</AnimatePresence>
	);
}

export function App() {
	return (
		<Router>
			<AppRoutes />
		</Router>
	);
}
