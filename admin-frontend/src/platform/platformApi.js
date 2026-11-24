const apiOrigin = (import.meta.env.VITE_API_ORIGIN || "").replace(/\/$/, "");
const publicBase = import.meta.env.BASE_URL.replace(/\/admin\/?$/, "").replace(
  /\/$/,
  "",
);
export const platformPath = (path) => `${publicBase}${path}`;
export async function platformRequest(path, token, options = {}) {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || "Unable to complete this request.");
  return data;
}
