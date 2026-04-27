import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from '@/app/AuthGate';
import { Layout } from '@/app/Layout';
import { Providers } from '@/app/providers';
import { routes } from '@/lib/routes';
import { ArchivePage } from '@/pages/Archive';
import { AskPage } from '@/pages/Ask';
import { BoardPage } from '@/pages/Board';
import { CaseFilePage } from '@/pages/CaseFile';
import { CaseFileReadingPage } from '@/pages/CaseFileReading';
import { DeskPage } from '@/pages/Desk';
import { AcceptInvitePage } from '@/pages/auth/AcceptInvite';
import { LoginPage } from '@/pages/auth/Login';

function ProtectedApp() {
  return (
    <AuthGate>
      <Layout />
    </AuthGate>
  );
}

export function App() {
  return (
    <Providers>
      <BrowserRouter>
        <Routes>
          <Route path={routes.login()} element={<LoginPage />} />
          <Route path={routes.acceptInvite(':token')} element={<AcceptInvitePage />} />
          <Route element={<ProtectedApp />}>
            <Route path={routes.desk()} element={<DeskPage />} />
            <Route path={routes.archive()} element={<ArchivePage />} />
            <Route path={routes.caseFile(':id')} element={<CaseFilePage />} />
            <Route path={routes.reading(':id', ':storyId')} element={<CaseFileReadingPage />} />
            <Route path={routes.board()} element={<BoardPage />} />
            <Route path={routes.ask()} element={<AskPage />} />
          </Route>
          <Route path="*" element={<Navigate to={routes.desk()} replace />} />
        </Routes>
      </BrowserRouter>
    </Providers>
  );
}
