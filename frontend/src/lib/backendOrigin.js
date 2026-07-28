const DEFAULT_BACKEND_PORT = '3001';

export function resolveBackendOrigin(configuredBaseUrl, location) {
  const configured = configuredBaseUrl?.trim();
  if (configured) return new URL(configured, location.origin).origin;

  const backendUrl = new URL(location.origin);
  if (backendUrl.protocol === 'https:') return backendUrl.origin;
  backendUrl.port = DEFAULT_BACKEND_PORT;
  return backendUrl.origin;
}

export function getBackendOrigin() {
  return resolveBackendOrigin(import.meta.env.VITE_API_BASE_URL, window.location);
}
