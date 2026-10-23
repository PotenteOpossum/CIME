export const runId =
  new URLSearchParams(window.location.search).get("run") || "";
export const socketOrigin =
  import.meta.env.VITE_SOCKET_URL || window.location.origin;
export const storage = {
  getItem: (key) =>
    localStorage.getItem(key === "theme" ? key : `cime:${runId}:${key}`),
  setItem: (key, value) =>
    localStorage.setItem(key === "theme" ? key : `cime:${runId}:${key}`, value),
  removeItem: (key) =>
    localStorage.removeItem(key === "theme" ? key : `cime:${runId}:${key}`),
};
export const transientStorage = {
  getItem: (key) => sessionStorage.getItem(`cime:${runId}:${key}`),
  setItem: (key, value) =>
    sessionStorage.setItem(`cime:${runId}:${key}`, value),
  removeItem: (key) => sessionStorage.removeItem(`cime:${runId}:${key}`),
};
