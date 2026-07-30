// ─────────────────────────────────────────────────────────────────────────────
// Shared Validation Functions — NEXO Backend
// Extracted from admin.js and other route files for consistent reuse.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a value is a non-empty string.
 * Returns the trimmed string. Throws 400 if invalid.
 */
function requireText(value, field) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    const err = new Error(`${field} is required.`);
    err.statusCode = 400;
    throw err;
  }
  return value.trim();
}

/**
 * Validate PATCH body has at least one allowed field.
 * Throws 400 if body is not an object or contains no valid keys.
 */
function requirePatchBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('PATCH body must be a JSON object.');
    err.statusCode = 400;
    throw err;
  }

  const validKeys = Object.keys(body).filter(key => allowedFields.includes(key));
  if (validKeys.length === 0) {
    const err = new Error(`PATCH body must include at least one valid field: ${allowedFields.join(', ')}.`);
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Validate a numeric ID is a positive integer (optional).
 * Returns the number, or null for empty/missing values.
 * Throws 400 if present but invalid.
 */
function optionalAreaId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(Number(value)) || Number(value) <= 0 || String(value).trim() !== String(Number(value))) {
    const err = new Error(`${field} must be a positive integer.`);
    err.statusCode = 400;
    throw err;
  }
  return Number(value);
}

/**
 * Validate a value is a positive integer (optional).
 * Returns the number, or undefined for empty/missing values.
 * Throws 400 if present but invalid.
 */
function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isInteger(Number(value)) || Number(value) <= 0 || String(value).trim() !== String(Number(value))) {
    const err = new Error(`${field} must be a positive integer.`);
    err.statusCode = 400;
    throw err;
  }
  return Number(value);
}

/**
 * Validate a value is a required positive integer.
 * Returns the number. Throws 400 if missing or invalid.
 */
function requiredPositiveInteger(value, field) {
  const normalized = optionalPositiveInteger(value, field);
  if (normalized === undefined) {
    const err = new Error(`${field} is required.`);
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

/**
 * Validate a value is an integer (optional).
 * Returns the number, or undefined for empty/missing values.
 * Throws 400 if present but not a valid integer.
 */
function optionalInteger(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isInteger(Number(value)) || String(value).trim() !== String(Number(value))) {
    const err = new Error(`${field} must be an integer.`);
    err.statusCode = 400;
    throw err;
  }
  return Number(value);
}

/**
 * Validate a value is a boolean (optional).
 * Returns the boolean, or undefined for empty/missing values.
 * Accepts 'true'/'false' strings. Throws 400 if invalid.
 */
function optionalBoolean(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const err = new Error(`${field} must be true or false.`);
  err.statusCode = 400;
  throw err;
}

/**
 * Validate request body contains exactly the specified fields.
 * Throws 400 if body is not an object, has extra fields, or missing fields.
 */
function requireExactBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
  const keys = Object.keys(body);
  if (keys.length !== allowedFields.length || keys.some(key => !allowedFields.includes(key))) {
    throw Object.assign(new Error(`Request body must contain exactly: ${allowedFields.join(', ')}.`), { statusCode: 400 });
  }
}

/**
 * Validate request body is empty.
 * Throws 400 if body is present and non-empty.
 */
function requireEmptyBody(body) {
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw Object.assign(new Error('Request body must be empty.'), { statusCode: 400 });
  }
}

/**
 * Check whether an error represents a PostgreSQL unique violation.
 */
function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key value|unique constraint|unique violation/i.test(error?.message || '');
}

/**
 * Execute an async operation and map PostgreSQL unique violations to a 409.
 */
async function mapUniqueViolation(operation, conflictMessage = 'Resource already exists.') {
  try {
    return await operation();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const conflict = new Error(conflictMessage);
      conflict.statusCode = 409;
      throw conflict;
    }
    throw err;
  }
}

module.exports = {
  requireText,
  requirePatchBody,
  optionalAreaId,
  optionalPositiveInteger,
  requiredPositiveInteger,
  optionalInteger,
  optionalBoolean,
  requireExactBody,
  requireEmptyBody,
  isUniqueViolation,
  mapUniqueViolation,
};
