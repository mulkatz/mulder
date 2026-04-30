import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { AuthGate } from '@/app/AuthGate';
import { AppShell } from '@/components/AppShell';
import { PageTransition } from '@/components/PageTransition';
import { AcceptInvitationPage } from '@/pages/AcceptInvitation';
import { AnalysisRunsPage } from '@/pages/AnalysisRuns';
import { EvidenceWorkspacePage } from '@/pages/EvidenceWorkspace';
import { LoginPage } from '@/pages/Login';
import { OverviewPage } from '@/pages/Overview';

export function App() {
	return (
		<Router>
			<Routes>
				<Route
					path="/login"
					element={
						<PageTransition>
							<LoginPage />
						</PageTransition>
					}
				/>
				<Route
					path="/auth/invitations/:token"
					element={
						<PageTransition>
							<AcceptInvitationPage />
						</PageTransition>
					}
				/>
				<Route element={<AuthGate />}>
					<Route element={<AppShell />}>
						<Route
							index
							element={
								<PageTransition>
									<OverviewPage />
								</PageTransition>
							}
						/>
						<Route
							path="/runs"
							element={
								<PageTransition>
									<AnalysisRunsPage />
								</PageTransition>
							}
						/>
						<Route
							path="/evidence"
							element={
								<PageTransition>
									<EvidenceWorkspacePage />
								</PageTransition>
							}
						/>
					</Route>
				</Route>
				<Route path="*" element={<Navigate replace to="/" />} />
			</Routes>
		</Router>
	);
}
