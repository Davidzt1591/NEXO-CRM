const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const NON_JSON_API_ERROR = 'No se pudo conectar con la API del backend. La respuesta no fue JSON.';
const INVALID_JSON_API_ERROR = 'La API respondió con JSON inválido. Intenta de nuevo y revisa la respuesta del backend si el problema continúa.';

export function getAuthToken() {
  return localStorage.getItem('nexo_token') || '';
}

function isTrustedApiPath(path) {
  try {
    const requestUrl = new URL(`${API_BASE_URL}${path}`, window.location.origin);
    const backendUrl = API_BASE_URL ? new URL(API_BASE_URL, window.location.origin) : null;

    return (
      requestUrl.origin === window.location.origin && requestUrl.pathname.startsWith('/api/')
    ) || (
      backendUrl && requestUrl.origin === backendUrl.origin
    );
  } catch {
    return false;
  }
}

function responseMetadata(response, contentType, text) {
  return {
    status: response.status,
    contentType,
    bodySnippet: text.slice(0, 160),
  };
}

function buildNonJsonMessage(path, response, contentType) {
  return `${NON_JSON_API_ERROR} Endpoint: ${path}. Estado: ${response.status}. Tipo recibido: ${contentType || 'sin content-type'}. Verifica que estés entrando por el puerto de Vite activo y que /api esté proxyando a http://localhost:3001.`;
}

function createApiError(message, response, contentType, text, data = null) {
  const error = new Error(message);
  error.status = response.status;
  error.contentType = contentType;
  error.bodySnippet = text.slice(0, 160);
  error.data = data;
  return error;
}

export async function apiRequest(path, options = {}) {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});

  if (token && isTrustedApiPath(path)) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('Content-Type') || '';
  const text = await response.text();

  if (text && !contentType.toLowerCase().includes('application/json')) {
    throw createApiError(buildNonJsonMessage(path, response, contentType), response, contentType, text);
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (cause) {
      const error = createApiError(INVALID_JSON_API_ERROR, response, contentType, text);
      error.cause = cause;
      throw error;
    }
  }

  if (!response.ok) {
    const error = new Error(data?.error || 'Request failed.');
    Object.assign(error, responseMetadata(response, contentType, text), { data });
    throw error;
  }

  return data;
}

export function jsonBody(payload) {
  return JSON.stringify(payload);
}
