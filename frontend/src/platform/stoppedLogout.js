// Preserve the first displayed stop deadline across navigation and reloads.
export function scheduleStoppedLogout(storage, key, logout) {
  const stored = Number(storage.getItem(key));
  const deadline =
    Number.isFinite(stored) && stored > 0 ? stored : Date.now() + 60000;
  storage.setItem(key, String(deadline));
  const timer = setTimeout(logout, Math.max(0, deadline - Date.now()));
  return () => clearTimeout(timer);
}
