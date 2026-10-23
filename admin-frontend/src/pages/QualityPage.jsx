import { lazy, Suspense } from "react";
import { useAdminAuth } from "../contexts/AdminAuthContext.jsx";
import { runId } from "../platform/context.js";
import cimeLogo from "../img/CIME_LOGO.png";

const QualityTab = lazy(() => import("../components/QualityTab.jsx"));

export default function QualityPage() {
  const { token } = useAdminAuth();
  return (
    <div className="quality-page">
      <header className="quality-page-header">
        <a href="/#/decisions" aria-label="CIME — My decisions">
          <img src={cimeLogo} alt="CIME" />
        </a>
        <a
          className="quality-action quality-action-secondary"
          href={`/#/runs/${runId}`}
        >
          <span aria-hidden="true">←</span> Back to decision
        </a>
      </header>
      <main className="quality-page-content">
        <Suspense fallback={<p role="status">Loading quality analysis…</p>}>
          <QualityTab token={token} />
        </Suspense>
      </main>
    </div>
  );
}
