import { runId } from '../platform/context.js';
const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/$/, '');
const API_BASE_URL = `${API_ORIGIN}/api/platform/runs/${runId}/engine`;

export async function apiRequest(path, options = {}, token) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function apiDownload(path, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed');
  }

  const disposition = response.headers.get('Content-Disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
  return {
    blob: await response.blob(),
    filename: filenameMatch?.[1] || 'cime-computed-run-data.json'
  };
}
