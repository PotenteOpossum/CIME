export const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN || "").replace(/\/$/, "");
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
export const platformPath = (path) => `${basePath}${path}`;
export const routePath = basePath && window.location.pathname.startsWith(`${basePath}/`)
  ? window.location.pathname.slice(basePath.length)
  : window.location.pathname;
export const participantRunId =
  routePath.match(/^\/participate\/([a-f0-9-]{36})\/?$/)?.[1] ||
  "";
export const sessionKey = (name) => `${name}:${participantRunId || "legacy"}`;
export const accountToken = () =>
  sessionStorage.getItem("cime_account_token") || "";
export async function platformRequest(
  path,
  options = {},
  token = accountToken(),
) {
  const response = await fetch(`${API_ORIGIN}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || "Unable to complete this request");
  return result;
}
export function saveAccount(session) {
  sessionStorage.setItem("cime_account_token", session.token);
  sessionStorage.setItem("cime_account_user", JSON.stringify(session.user));
}
export function saveParticipant(session) {
  sessionStorage.removeItem(`stop_logout_at:${session.runId}`);
  sessionStorage.removeItem(`participation_stopped:${session.runId}`);
  sessionStorage.removeItem(`participation_completed:${session.runId}`);
  sessionStorage.removeItem(`completion_url:${session.runId}`);
  sessionStorage.setItem(`chat_jwt_token:${session.runId}`, session.token);
  sessionStorage.setItem(
    `chat_user:${session.runId}`,
    JSON.stringify(session.user),
  );
  if (session.recoveryCode)
    sessionStorage.setItem(`recovery:${session.runId}`, session.recoveryCode);
}
