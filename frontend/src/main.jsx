import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

function getRequestUrl(input) {
  return input instanceof Request ? input.url : input;
}

function shouldAttachDashboardToken(input) {
  const requestUrl = new URL(getRequestUrl(input), window.location.origin);
  const backendUrl = new URL(API_BASE_URL, window.location.origin);

  return (requestUrl.origin === window.location.origin && requestUrl.pathname.startsWith('/api/')) || requestUrl.origin === backendUrl.origin;
}

// Intercept trusted API fetches to append the dashboard Authorization token automatically
const originalFetch = window.fetch;
window.fetch = async (url, options = {}) => {
  const token = localStorage.getItem('nexo_token');
  if (token && shouldAttachDashboardToken(url)) {
    const headers = new Headers(url instanceof Request ? url.headers : undefined);
    new Headers(options.headers || {}).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Bearer ${token}`);
    options = {
      ...options,
      headers,
    };
  }
  const res = await originalFetch(url, options);
  if (res.status === 401) {
    localStorage.removeItem('nexo_token');
    window.location.reload();
  }
  return res;
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
