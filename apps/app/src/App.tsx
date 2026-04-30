import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { AnalysisRunsPage } from '@/pages/AnalysisRuns';
import { EvidenceWorkspacePage } from '@/pages/EvidenceWorkspace';
import { OverviewPage } from '@/pages/Overview';

export function App() {
	return (
		<Router>
			<Routes>
				<Route element={<AppShell />}>
					<Route index element={<OverviewPage />} />
					<Route path="/runs" element={<AnalysisRunsPage />} />
					<Route path="/evidence" element={<EvidenceWorkspacePage />} />
				</Route>
				<Route path="*" element={<Navigate replace to="/" />} />
			</Routes>
		</Router>
	);
}
