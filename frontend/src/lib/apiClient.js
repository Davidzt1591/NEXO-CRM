import { getBackendOrigin } from './backendOrigin';
import { INVALID_AUTH_CODES, invalidateCurrentSession } from './authSession';

const API_BASE_URL = getBackendOrigin();
const NON_JSON_API_ERROR = 'No se pudo conectar con la API del backend. La respuesta no fue JSON.';
const INVALID_JSON_API_ERROR = 'La API respondió con JSON inválido. Intenta de nuevo y revisa la respuesta del backend si el problema continúa.';
export const RATE_LIMITED_EVENT = 'nexo:rate-limited';
export const RATE_LIMIT_RECOVERED_EVENT = 'nexo:rate-limit-recovered';

function requestSignature(path, options) {
  return `${String(options.method || 'GET').toUpperCase()} ${resolveApiUrl(path)}`;
}

function notifyRateLimit(name, detail) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
}

function resolveApiUrl(path) {
  try {
    return new URL(path).toString();
  } catch {
    return `${API_BASE_URL}${path}`;
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
  return `${NON_JSON_API_ERROR} Endpoint: ${path}. Estado: ${response.status}. Tipo recibido: ${contentType || 'sin content-type'}. Verifica que el backend esté activo en http://localhost:3001 o configura VITE_API_BASE_URL.`;
}

function createApiError(message, response, contentType, text, data = null) {
  const error = new Error(message);
  error.status = response.status;
  error.contentType = contentType;
  error.bodySnippet = text.slice(0, 160);
  error.data = data;
  error.code = data?.code || null;
  return error;
}

export async function apiRequest(path, options = {}) {
  const signature = requestSignature(path, options);
  const { sensitiveResponse = false, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});

  if (fetchOptions.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(resolveApiUrl(path), {
    ...fetchOptions,
    headers,
    credentials: 'include',
  });

  const contentType = response.headers.get('Content-Type') || '';
  if (sensitiveResponse && !response.ok) {
    const error = new Error('No se pudo completar la operación sensible.');
    error.status = response.status;
    throw error;
  }
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
    const retryAfterHeader = response.headers.get('Retry-After');
    const headerRetryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
    const retryAfterSeconds = data?.retryAfterSeconds != null && Number.isFinite(Number(data.retryAfterSeconds))
      ? Math.max(1, Math.ceil(Number(data.retryAfterSeconds)))
      : Number.isFinite(headerRetryAfter) ? Math.max(1, Math.ceil(headerRetryAfter)) : null;
    Object.assign(error, responseMetadata(response, contentType, text), { data, code: data?.code || null, retryAfterSeconds });
    if (response.status === 401 && INVALID_AUTH_CODES.has(error.code)) invalidateCurrentSession({ code: error.code });
    if (error.code === 'RATE_LIMITED') notifyRateLimit(RATE_LIMITED_EVENT, {
      signature,
      retryAfterSeconds,
      message: error.message,
    });
    throw error;
  }

  notifyRateLimit(RATE_LIMIT_RECOVERED_EVENT, { signature });
  return data;
}

export function jsonBody(payload) {
  return JSON.stringify(payload);
}
