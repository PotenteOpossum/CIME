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
import { participantRunId } from "./platform/client.js";
import ParticipantGate from "./platform/ParticipantGate.jsx";

function ProtectedRoute({ children }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { token } = useAuth();

  const invitation = window.location.pathname.match(
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
