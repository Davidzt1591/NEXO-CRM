const MAX_DECODED_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIMETYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

const SUPPORTED_MEDIA_TYPES_MESSAGE = 'Supported WhatsApp media types: image/jpeg, image/png, image/gif, image/webp, application/pdf.';

const MAX_FILENAME_LENGTH = 120;

function normalizeBase64(data, mimetype = '') {
  if (typeof data !== 'string') return data;
  const trimmed = data.trim();
  const dataUrl = trimmed.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
  let value = trimmed;

  if (trimmed.startsWith('data:')) {
    if (!dataUrl) throw mediaError('Malformed data URL media payload.', 400);
    if (mimetype && dataUrl[1].toLowerCase() !== mimetype) {
      throw mediaError('Data URL mimetype does not match media mimetype.', 400);
    }
    value = dataUrl[2];
  }

  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || /=/.test(value.slice(0, -2))) {
    throw mediaError('Media data must be strict base64.', 400);
  }

  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0) throw mediaError('Media data must not decode to an empty payload.', 400);
  if (buffer.toString('base64') !== value) throw mediaError('Media data must be canonical base64.', 400);
  return { data: value, buffer };
}

function decodedSize(base64) {
  return normalizeBase64(base64).buffer.length;
}

function mediaError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sanitizeFilename(filename, mimetype) {
  const fallback = defaultFilename(mimetype);
  const raw = String(filename || fallback).replace(/[/\\]/g, '-').replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = raw.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/_+/g, '_').replace(/\s+/g, ' ').trim();
  const safe = (cleaned || fallback).replace(/^\.+/, '') || fallback;
  return safe.slice(0, MAX_FILENAME_LENGTH);
}

function hasMagicBytes(buffer, mimetype) {
  if (mimetype === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimetype === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimetype === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (mimetype === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimetype === 'application/pdf') return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  return false;
}

function validateWhatsAppMedia(media, { maxBytes = MAX_DECODED_BYTES } = {}) {
  if (!media || typeof media !== 'object') {
    const err = new Error('Media payload is required.');
    err.statusCode = 400;
    throw err;
  }

  const mimetype = String(media.mimetype || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIMETYPES.has(mimetype)) {
    const err = new Error(`Unsupported WhatsApp media type: ${mimetype || 'unknown'}. ${SUPPORTED_MEDIA_TYPES_MESSAGE}`);
    err.statusCode = 415;
    throw err;
  }

  if (!media.data || typeof media.data !== 'string') throw mediaError('Media data must be a base64 string.', 400);

  const { data, buffer } = normalizeBase64(media.data, mimetype);

  const sizeBytes = buffer.length;
  if (sizeBytes > maxBytes) {
    throw mediaError(`WhatsApp media exceeds ${maxBytes} bytes.`, 413);
  }

  if (!hasMagicBytes(buffer, mimetype)) {
    throw mediaError(`Media content does not match declared type: ${mimetype}.`, 415);
  }

  return {
    data,
    mimetype,
    filename: sanitizeFilename(media.filename, mimetype),
    sizeBytes,
  };
}

function defaultFilename(mimetype) {
  const ext = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  }[mimetype] || 'bin';
  return `whatsapp-media.${ext}`;
}

module.exports = {
  MAX_DECODED_BYTES,
  ALLOWED_MIMETYPES,
  validateWhatsAppMedia,
  decodedSize,
  normalizeBase64,
  sanitizeFilename,
  hasMagicBytes,
};
