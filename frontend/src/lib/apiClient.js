const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export function getAuthToken() {
  return localStorage.getItem('nexo_token') || '';
}

export async function apiRequest(path, options = {}) {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});

  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.error || 'Request failed.');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export function jsonBody(payload) {
  return JSON.stringify(payload);
}
