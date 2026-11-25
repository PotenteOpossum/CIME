import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import LoginPage from "./pages/LoginPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import ChatPage from "./pages/ChatPage.jsx";
import AgentsPage from "./pages/AgentsPage.jsx";
import DocsPage from "./pages/DocsPage.jsx";
import { useAuth } from "./contexts/AuthContext.jsx";
import GlobalAlert from "./components/GlobalAlert.jsx";
import {
  HomePage,
  AccountPage,
  DecisionsPage,
  RunPage,
  JoinPage,
} from "./platform/PlatformPages.jsx";
import { participantRunId, routePath } from "./platform/client.js";
import ParticipantGate from "./platform/ParticipantGate.jsx";

// Development-only Test Lab (see src/testlab). Not included in production builds.
const TestLab = import.meta.env.DEV ? lazy(() => import("./testlab/TestLab.jsx")) : null;
const TestLabTile = import.meta.env.DEV ? lazy(() => import("./testlab/TestLabTile.jsx")) : null;

function ProtectedRoute({ children }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { token } = useAuth();

  if (TestLab && /^\/test-lab\/?$/.test(routePath))
    return <Suspense fallback={null}><TestLab /></Suspense>;
  if (TestLabTile && /^\/test-lab\/tile\/?$/.test(routePath))
    return <Suspense fallback={null}><TestLabTile /></Suspense>;
  const invitation = routePath.match(
    /^\/join\/([a-zA-Z0-9_-]+)\/?$/,
  )?.[1];
  if (invitation) return <JoinPage invite={invitation} />;
  if (!participantRunId)
    return (
      <>
        <GlobalAlert />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/account/:action" element={<AccountPage />} />
          <Route path="/decisions" element={<DecisionsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/doc" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </>
    );
  return (
    <ParticipantGate>
      <GlobalAlert />
      <Routes>
        <Route path="/doc" element={<DocsPage />} />
        <Route
          path="/login"
          element={token ? <Navigate to="/dashboard" replace /> : <LoginPage />}
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/chat/:roomId"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents"
          element={
            <ProtectedRoute>
              <AgentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="*"
          element={<Navigate to={token ? "/dashboard" : "/login"} replace />}
        />
      </Routes>
    </ParticipantGate>
  );
}
