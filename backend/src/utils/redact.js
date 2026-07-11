const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';

const SECRET_KEY_PATTERN = /(authorization|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|private[_-]?key|database[_-]?url|db[_-]?url|password|assertion|secret)/i;
const EMAIL_KEY_PATTERN = /(email|correo)/i;
const PHONE_KEY_PATTERN = /(phone|telefono|teléfono|mobile|whatsapp)/i;
const DOCUMENT_KEY_PATTERN = /(document|documento|identification|identificacion|identificación|cedula|cédula|dni|nit|passport|id[_-]?number)/i;
const LONG_TEXT_KEY_PATTERN = /(description|descripcion|descripción|commentbody|comment|message|mensaje|body|transcript|resolution|resolucion|resolución)/i;

function redactTextForLog(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/([?&](?:token|access_token|refresh_token|client_secret|assertion|password)=)[^\s&#]+/gi, `$1${REDACTED}`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/(?:\+?\d[\d().\-\s]{7,}\d)/g, REDACTED)
    .replace(/(-----BEGIN [^-]+ PRIVATE KEY-----)[\s\S]*?(-----END [^-]+ PRIVATE KEY-----)/gi, `$1\n${REDACTED}\n$2`)
    .replace(/(client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|token|database[_-]?url|db[_-]?url|authorization|assertion|password)\s*[:=]\s*[^\s,}]+/gi, `$1=${REDACTED}`);
}

function truncateLongText(value) {
  const text = redactTextForLog(value);
  if (text.length <= 80) return text;
  return `${text.slice(0, 80)}... ${TRUNCATED}`;
}

function redactValueForKey(key, value, seen) {
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (EMAIL_KEY_PATTERN.test(key)) return value ? REDACTED : value;
  if (PHONE_KEY_PATTERN.test(key)) return value ? REDACTED : value;
  if (DOCUMENT_KEY_PATTERN.test(key)) return value ? REDACTED : value;
  if (LONG_TEXT_KEY_PATTERN.test(key) && typeof value === 'string') return truncateLongText(value);
  return redactForLog(value, seen);
}

function redactForLog(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactTextForLog(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactTextForLog(value.message),
      code: value.code,
      statusCode: value.statusCode,
    };
  }
  if (Buffer.isBuffer(value)) return `[Buffer:${value.length}]`;
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map(item => redactForLog(item, seen));

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactValueForKey(key, child, seen)])
    );
  }
  return value;
}

function safeStringifyForLog(value) {
  try {
    return JSON.stringify(redactForLog(value));
  } catch {
    return REDACTED;
  }
}

function redactLogArgs(args) {
  return Array.from(args).map(arg => redactForLog(arg));
}

module.exports = {
  REDACTED,
  redactForLog,
  redactLogArgs,
  redactTextForLog,
  safeStringifyForLog,
};
