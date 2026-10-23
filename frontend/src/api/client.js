import { participantRunId, API_ORIGIN } from '../platform/client.js';
const API_BASE_URL = participantRunId ? `${API_ORIGIN}/api/platform/runs/${participantRunId}/engine` : (import.meta.env.VITE_API_BASE_URL || '/api');

export async function apiRequest(path, options = {}, token) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}
