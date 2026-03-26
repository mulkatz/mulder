import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SourceDetail from './pages/SourceDetail';
import Review from './pages/Review';
import Stories from './pages/Stories';
import Graph from './pages/Graph';
import Board from './pages/Board';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sources/:id" element={<SourceDetail />} />
          <Route path="/sources/:id/review/:storyId" element={<Review />} />
          <Route path="/stories" element={<Stories />} />
          <Route path="/graph" element={<Graph />} />
          <Route path="/boards/:id" element={<Board />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
