import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { AuthGate } from '@/app/AuthGate';
import { AppShell } from '@/components/AppShell';
import { AcceptInvitationPage } from '@/pages/AcceptInvitation';
import { AnalysisRunsPage } from '@/pages/AnalysisRuns';
import { EvidenceWorkspacePage } from '@/pages/EvidenceWorkspace';
import { LoginPage } from '@/pages/Login';
import { OverviewPage } from '@/pages/Overview';

export function App() {
	return (
		<Router>
			<Routes>
				<Route path="/login" element={<LoginPage />} />
				<Route path="/auth/invitations/:token" element={<AcceptInvitationPage />} />
				<Route element={<AuthGate />}>
					<Route element={<AppShell />}>
						<Route index element={<OverviewPage />} />
						<Route path="/runs" element={<AnalysisRunsPage />} />
						<Route path="/evidence" element={<EvidenceWorkspacePage />} />
					</Route>
				</Route>
				<Route path="*" element={<Navigate replace to="/" />} />
			</Routes>
		</Router>
	);
}
