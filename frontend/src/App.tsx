import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { LifecyclePage } from './pages/LifecyclePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RequestActivityPage } from './pages/RequestActivityPage';
import { SlaPoliciesPage } from './pages/SlaPoliciesPage';

/**
 * Route table. Authentication guards (`<RequireAuth roles=[…]>`, docs/system-architecture.md §6)
 * arrive with Phase 5; the scaffolded pages are contract/config surfaces that any user may read.
 * `/requests/:id/activity` is the exception worth noting: it renders the API's own error envelope
 * when the caller is anonymous or out of scope, because hiding it would imply the UI enforces access.
 */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="lifecycle" element={<LifecyclePage />} />
        <Route path="sla/policies" element={<SlaPoliciesPage />} />
        <Route path="requests/:id/activity" element={<RequestActivityPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
