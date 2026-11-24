import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAdminAuth } from "./contexts/AdminAuthContext.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import AdminDashboard from "./pages/AdminDashboard.jsx";
import QualityPage from "./pages/QualityPage.jsx";
import SurveysTab from './components/SurveysTab.jsx';

import GlobalAlert from "./components/GlobalAlert.jsx";
import RunToolbar from "./platform/RunToolbar.jsx";
import { runId } from "./platform/context.js";
import { OwnedRunProvider, useOwnedRun } from './platform/OwnedRunContext.jsx';
import SimplifiedWorkspace from './platform/SimplifiedWorkspace.jsx';
import { platformPath } from './platform/platformApi.js';

function ProtectedRoute({ children }) {
  const { token, user } = useAdminAuth();
  if (!token || !user?.is_admin) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { token, user } = useAdminAuth();
  if (!token || !user?.is_admin || !runId) return <FullWorkspace />;
  return <OwnedRunProvider><WorkspaceBoundary /></OwnedRunProvider>;
}
function WorkspaceBoundary() {
  const { run, error, refresh } = useOwnedRun();
  if (error) return <div className="p-8"><p role="alert">{error}</p><button onClick={() => refresh().catch(() => {})}>Retry</button><a href={platformPath('/#/decisions')}>Back to my decisions</a></div>;
  if (!run) return <p role="status" className="p-8">Loading discussion workspace…</p>;
  if (run.discussion_type === 'simplified') return <div className="admin-theme"><GlobalAlert/><SimplifiedWorkspace/></div>;
  return <FullWorkspace />;
}
function FullWorkspace() {
  const location = useLocation();
  const { token, user } = useAdminAuth();
  useEffect(() => {
    document.documentElement.classList.remove("dark");
  }, []);

  if (!token || !user?.is_admin || !runId)
    return (
      <div className="p-12">
        <h1 className="text-2xl">Open a decision from your dashboard</h1>
        <a className="text-blue-600" href={platformPath('/#/decisions')}>
          Go to my decisions
        </a>
      </div>
    );
  return (
    <div className="admin-theme">
      {location.pathname !== "/quality" && <RunToolbar />}
      <GlobalAlert />
      <Routes>
        <Route
          path="/login"
          element={
            token && user?.is_admin ? (
              <Navigate to="/" replace />
            ) : (
              <LoginPage />
            )
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AdminDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/quality"
          element={
            <ProtectedRoute>
              <QualityPage />
            </ProtectedRoute>
          }
        />
        <Route path="/surveys" element={<ProtectedRoute><SurveysTab token={token} /></ProtectedRoute>} />
        <Route
          path="*"
          element={<Navigate to={token ? "/" : "/login"} replace />}
        />
      </Routes>
    </div>
  );
}
