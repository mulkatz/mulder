import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SourceLibrary from './pages/SourceLibrary';
import SourceDetail from './pages/SourceDetail';
import Review from './pages/Review';
import Stories from './pages/Stories';
import StoryDetail from './pages/StoryDetail';
import EntityList from './pages/EntityList';
import EntityDetail from './pages/EntityDetail';
import Graph from './pages/Graph';
import Evidence from './pages/Evidence';
import Board from './pages/Board';
import Upload from './pages/Upload';
import Settings from './pages/Settings';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/sources" element={<SourceLibrary />} />
          <Route path="/sources/:id" element={<SourceDetail />} />
          <Route path="/sources/:id/review/:storyId" element={<Review />} />
          <Route path="/stories" element={<Stories />} />
          <Route path="/stories/:id" element={<StoryDetail />} />
          <Route path="/entities" element={<EntityList />} />
          <Route path="/entities/:id" element={<EntityDetail />} />
          <Route path="/graph" element={<Graph />} />
          <Route path="/evidence" element={<Evidence />} />
          <Route path="/boards/:id" element={<Board />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
