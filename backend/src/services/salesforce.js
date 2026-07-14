// ─────────────────────────────────────────────────────────────────────────────
// Salesforce REST API Service — NEXO Integration Layer
// Operates as a secure backend proxy: credentials NEVER reach the browser.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const SF_INSTANCE   = process.env.SALESFORCE_INSTANCE_URL || 'https://magneto365.my.salesforce.com';
const SF_LOGIN_URL  = process.env.SALESFORCE_LOGIN_URL    || 'https://magneto365.my.salesforce.com';
const SF_VERSION    = process.env.SALESFORCE_API_VERSION  || 'v60.0';
const CLIENT_ID     = process.env.SALESFORCE_CLIENT_ID;
const CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET;
const { SALESFORCE_REQUEST_TIMEOUT_MS: SF_REQUEST_TIMEOUT_MS } = require('./salesforceOutboxContract');

// ── In-memory caches ──────────────────────────────────────────────────────────
let tokenCache = {
  accessToken : null,
  expiresAt   : 0,
  idUrl       : null,
  ownerInfo   : null,
};

let describeCache = {
  data      : null,
  expiresAt : 0,
};

// ── Token Management ──────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { ALLOWED_MIMETYPES, hasMagicBytes, normalizeBase64, sanitizeFilename } = require('./mediaValidation');
const { redactForLog } = require('../utils/redact');

const DEFAULT_PRIVATE_KEY_PATH = path.resolve(__dirname, '..', '..', 'certs', 'salesforce.key');

async function fetchWithSalesforceTimeout(url, options = {}, consume, timeoutMs = SF_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await consume(response, controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeoutError = new Error('Salesforce request timed out.');
      timeoutError.code = 'SF_REQUEST_TIMEOUT';
      timeoutError.statusCode = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonText(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function resolveSalesforcePrivateKey(env = process.env, fsModule = fs) {
  if (env.SALESFORCE_PRIVATE_KEY) {
    return { privateKey: env.SALESFORCE_PRIVATE_KEY.replace(/\\n/g, '\n'), source: 'SALESFORCE_PRIVATE_KEY' };
  }

  const configuredPath = env.SALESFORCE_PRIVATE_KEY_PATH;
  if (configuredPath) {
    const keyPath = path.resolve(configuredPath);
    if (!fsModule.existsSync(keyPath)) {
      throw new Error('Salesforce no configurado. SALESFORCE_PRIVATE_KEY_PATH no existe.');
    }
    return { privateKey: fsModule.readFileSync(keyPath, 'utf8'), source: 'SALESFORCE_PRIVATE_KEY_PATH' };
  }

  if (fsModule.existsSync(DEFAULT_PRIVATE_KEY_PATH)) {
    return { privateKey: fsModule.readFileSync(DEFAULT_PRIVATE_KEY_PATH, 'utf8'), source: DEFAULT_PRIVATE_KEY_PATH };
  }

  return null;
}

function buildSafeSalesforceErrorMessage(status, body) {
  const first = Array.isArray(body) ? body[0] : body;
  const rawCode = String(first?.errorCode || first?.code || '').toUpperCase();
  const code = /^[A-Z0-9_:-]{1,120}$/.test(rawCode) ? rawCode : `SF_HTTP_${status}`;
  return `Salesforce request failed (${Number(status) || 'unknown'}, ${code}).`;
}

function createSalesforceError(status, body) {
  const err = new Error(buildSafeSalesforceErrorMessage(status, body));
  err.statusCode = Number(status) || undefined;
  const first = Array.isArray(body) ? body[0] : body;
  err.code = String(first?.errorCode || first?.code || `SF_HTTP_${status}`).toUpperCase();
  return err;
}

async function getToken(force = false) {
  if (!force && tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  if (!CLIENT_ID) {
    throw new Error('Salesforce no configurado. Agrega SALESFORCE_CLIENT_ID al archivo .env');
  }

  const keyConfig = resolveSalesforcePrivateKey();
  let accessToken = null;

  // 1. Try JWT Bearer flow if private key material is configured.
  if (keyConfig) {
    console.log(`🛡️  Certificado detectado (${keyConfig.source}). Iniciando autenticación JWT con Salesforce...`);
    const privateKey = keyConfig.privateKey;
    const username = process.env.SALESFORCE_USERNAME || 'soporte.mgt@magnetoglobal.com';

    const jwtPayload = {
      iss: CLIENT_ID,
      sub: username,
      aud: SF_LOGIN_URL,
      exp: Math.floor(Date.now() / 1000) + (5 * 60) // 5 minutes max expiration
    };

    // Sign the JWT assertion locally
    const assertion = jwt.sign(jwtPayload, privateKey, { algorithm: 'RS256' });

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion
    });

    const result = await fetchWithSalesforceTimeout(`${SF_LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    }, async res => ({ status: res.status, ok: res.ok, text: await res.text() }));

    if (result.ok) {
      const data = parseJsonText(result.text) || {};
      accessToken = data.access_token;
      console.log('🔑 JWT Bearer token obtenido de Salesforce exitosamente.');
    } else {
      const error = createSalesforceError(result.status, parseJsonText(result.text));
      console.warn(`⚠️  Falló autenticación JWT (${result.status}, ${error.code}). Reintentando con credenciales básicas...`);
    }
  }

  // 2. Fallback to client_credentials if no cert or JWT failed
  if (!accessToken) {
    if (!CLIENT_SECRET) {
      throw new Error('Salesforce no configurado. Falta SALESFORCE_CLIENT_SECRET para fallback.');
    }
    console.log('🔑 Iniciando autenticación por credenciales básicas...');
    const params = new URLSearchParams({
      grant_type    : 'client_credentials',
      client_id     : CLIENT_ID,
      client_secret : CLIENT_SECRET,
    });

    const result = await fetchWithSalesforceTimeout(`${SF_LOGIN_URL}/services/oauth2/token`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body    : params.toString(),
    }, async res => ({ status: res.status, ok: res.ok, text: await res.text() }));

    if (!result.ok) {
      throw createSalesforceError(result.status, parseJsonText(result.text));
    }

    const data = parseJsonText(result.text) || {};
    accessToken = data.access_token;
  }

  tokenCache.accessToken = accessToken;
  tokenCache.expiresAt   = Date.now() + (55 * 60 * 1000); // 55 min (buffer)
  tokenCache.ownerInfo   = null;

  return accessToken;
}

async function _fetchOwnerInfo(token, idUrl) {
  if (!idUrl) return;
  try {
    const result = await fetchWithSalesforceTimeout(idUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    }, async res => ({ ok: res.ok, text: await res.text() }));
    if (result.ok) {
      const data = parseJsonText(result.text) || {};
      tokenCache.ownerInfo = {
        userId      : data.user_id,
        displayName : data.display_name,
        email       : data.email,
        username    : data.preferred_username,
      };
      console.log(`👤 Salesforce identity: ${data.display_name} (${data.user_id})`);
    }
  } catch (e) {
    console.warn('⚠️ No se pudo obtener la identidad del usuario SF:', e.message);
  }
}

// ── Base Request (with 401 auto-retry) ───────────────────────────────────────

async function sfRequest(method, path, body = null, extraHeaders = {}, isRetry = false, timeoutMs = SF_REQUEST_TIMEOUT_MS) {
  const token = await getToken();
  const url   = `${SF_INSTANCE}/services/data/${SF_VERSION}${path}`;

  const opts = {
    method,
    headers: {
      'Authorization' : `Bearer ${token}`,
      'Content-Type'  : 'application/json',
      ...extraHeaders,
    },
  };

  if (body !== null) opts.body = JSON.stringify(body);

  const result = await fetchWithSalesforceTimeout(url, opts, async res => ({
    status: res.status,
    ok: res.ok,
    text: res.status === 204 ? '' : await res.text(),
  }), timeoutMs);

  // Auto-refresh on 401
  if (result.status === 401 && !isRetry) {
    console.warn('🔄 Token SF expirado. Refrescando y reintentando...');
    tokenCache.accessToken = null;
    tokenCache.expiresAt   = 0;
    return sfRequest(method, path, body, extraHeaders, true, timeoutMs);
  }

  // PATCH success has no body
  if (result.status === 204) return { success: true };

  const text = result.text;
  if (!text) {
    if (!result.ok) throw createSalesforceError(result.status, null);
    return null;
  }

  let json;
  try { json = JSON.parse(text); } catch {
    const err = new Error(`SF API ${result.status}: invalid response.`);
    err.statusCode = result.status;
    err.code = 'SF_INVALID_RESPONSE';
    throw err;
  }

  if (!result.ok) {
    const error = createSalesforceError(result.status, json);
    console.error('❌ Salesforce request failed:', { status: result.status, code: error.code });
    throw error;
  }

  return json;
}

// ── Owner Identity ────────────────────────────────────────────────────────────

async function getOwnerInfo() {
  if (!tokenCache.ownerInfo) {
    await getToken(true); // Force refresh to get owner info
  }
  return tokenCache.ownerInfo;
}

// ── Case Operations ───────────────────────────────────────────────────────────

const AUTO_ASSIGN_HEADER = { 'Sforce-Auto-Assign': 'FALSE' };

async function obtenerCase(id) {
  const fields = [
    'Id', 'CaseNumber', 'Subject', 'Status', 'Origin', 'Priority',
    'AccountId', 'OwnerId', 'SuppliedName', 'SuppliedEmail', 'SuppliedPhone',
    'Categoria__c', 'Tipificacion__c', 'Atribuible__c', 'Plataforma__c',
    'Nivel_de_atenci_n__c', 'Pais__c', 'Tipo_de_cliente__c',
    'Soluci_n_primer_contacto__c', 'Marca__c', 'Subetapa_asignado__c',
    'Agente_due_o_del_ticket__c', 'Escalado_a_nivel_t_cnico__c', 'Subetapa_resuelto__c',
    'Gestionado_por_integraciones__c',
  ];
  const data = await sfRequest('GET', `/sobjects/Case/${id}?fields=${fields.join(',')}`);

  if (data?.AccountId) {
    try {
      const acc = await sfRequest('GET', `/sobjects/Account/${data.AccountId}?fields=Id,Name`);
      data.Account = { Id: acc.Id, Name: acc.Name };
    } catch (e) {
      data.Account = { Id: data.AccountId, Name: data.AccountId };
    }
  }

  return data;
}

async function getCaseCloseState(id) {
  if (!id) throw new Error('Salesforce Case id is required.');
  return sfRequest('GET', `/sobjects/Case/${encodeURIComponent(id)}?fields=Id,Status,Subetapa_resuelto__c`);
}

async function closeCaseFromOutbox(id, substage) {
  if (!id || !substage) throw new Error('Salesforce Case id and resolution substage are required.');
  await sfRequest('PATCH', `/sobjects/Case/${encodeURIComponent(id)}`, {
    Status: 'Resuelto',
    Subetapa_resuelto__c: substage,
  }, AUTO_ASSIGN_HEADER);
  return { success: true };
}

async function crearCase(payload) {
  const owner = await getOwnerInfo();

  const casePayload = {
    ...payload,
    OwnerId: owner?.userId || undefined,
  };

  // Mapeo automático Status → Subetapa_asignado__c (requerido por Flow de SF)
  if (casePayload.Status === 'Asignado' && !casePayload.Subetapa_asignado__c) {
    casePayload.Subetapa_asignado__c = 'Asignado';
  }

  // Origen por defecto si no se especifica
  if (!casePayload.Origin) {
    casePayload.Origin = 'Bot';
  }

  // Remove undefined/null entries
  Object.keys(casePayload).forEach(k => {
    if (casePayload[k] === undefined || casePayload[k] === null || casePayload[k] === '') {
      delete casePayload[k];
    }
  });

  console.log('📤 Payload a enviar:', JSON.stringify(redactForLog(casePayload), null, 2));

  const created = await sfRequest('POST', '/sobjects/Case', casePayload, AUTO_ASSIGN_HEADER);

  // GET the full Case record to retrieve the human-readable CaseNumber
  const caseData = await sfRequest(
    'GET',
    `/sobjects/Case/${created.id}?fields=Id,CaseNumber,Subject,Status,AccountId,OwnerId`
  );

  console.log(`✅ Case SF creado: #${caseData.CaseNumber} (${created.id})`);
  return { id: created.id, CaseNumber: caseData.CaseNumber, ...caseData };
}

async function getDescribe() {
  if (describeCache.data && Date.now() < describeCache.expiresAt) {
    return describeCache.data;
  }

  const PICKLIST_FIELDS = [
    'Origin',
    'Agente_due_o_del_ticket__c',
    'Categoria__c',
    'Tipificacion__c',
    'Atribuible__c',
    'Plataforma__c',
    'Nivel_de_atenci_n__c',
    'Priority',
    'Pais__c',
    'Tipo_de_cliente__c',
    'Soluci_n_primer_contacto__c',
    'Marca__c',
    'Subetapa_asignado__c',
    'Escalado_a_nivel_t_cnico__c',
    'Subetapa_resuelto__c',
    'subetapa_en_espera__c',
    'Gestionado_por_integraciones__c',
    'Status',
  ];

  // Intentar primero con UI-API (trae dependencias nativas)
  try {
    const DEFAULT_RECORD_TYPE = '012000000000000AAA';
    const uiData = await sfRequest(
      'GET',
      `/ui-api/picklist-values/${DEFAULT_RECORD_TYPE}/Case`
    );

    console.log('📋 UI-API response keys:', Object.keys(uiData || {}));

    const picklists = {};
    const dependencies = {};

    for (const fieldApiName of PICKLIST_FIELDS) {
      const fieldData = uiData?.picklistFieldValues?.[fieldApiName];
      if (!fieldData) continue;

      if (fieldData?.values?.length) {
        picklists[fieldApiName] = fieldData.values
          .filter(v => v.active !== false)
          .map(v => ({
            label: v.label,
            value: v.value,
            validFor: v.validFor || null,  // array of controller indexes
          }));
      }

      // If this field has a controller (i.e. it's a dependent picklist), save that info
      if (fieldData.controllerValues && Object.keys(fieldData.controllerValues).length > 0) {
        dependencies[fieldApiName] = {
          controllerField: null, // will be resolved below
          controllerValues: fieldData.controllerValues,
        };
      }
    }

    // Resolve controllerField names by checking which fields are referenced
    // The UI-API doesn't directly tell "which field controls this one", but we can infer from
    // Salesforce's describe or by knowing the org schema.
    // Strategy: for each dependent field, scan all other picklist fields to see which one's values
    // match the keys in controllerValues.
    for (const [depField, depInfo] of Object.entries(dependencies)) {
      const controllerKeys = Object.keys(depInfo.controllerValues);
      for (const [candidateField, candidateValues] of Object.entries(picklists)) {
        if (candidateField === depField) continue;
        const candidateLabels = candidateValues.map(v => v.value);
        const matches = controllerKeys.filter(k => candidateLabels.includes(k));
        if (matches.length >= controllerKeys.length * 0.5 && matches.length > 0) {
          depInfo.controllerField = candidateField;
          break;
        }
      }
    }

    console.log('📋 Dependencias detectadas:', JSON.stringify(
      Object.fromEntries(Object.entries(dependencies).map(([k,v]) => [k, v.controllerField || '?']))
    ));

    if (Object.keys(picklists).length > 0) {
      const result = { picklists, dependencies };
      describeCache.data      = result;
      describeCache.expiresAt = Date.now() + 60 * 60 * 1000;
      console.log('📋 Picklist values (UI-API) cacheados:', Object.keys(picklists).length, 'campos.');
      return result;
    }
    console.warn('⚠️ UI-API no devolvió valores, fallback a describe...');
  } catch (e) {
    console.warn('⚠️ UI-API falló, fallback a describe:', e.message);
  }

  // Fallback: usar el describe tradicional (sin dependencias)
  const describe = await sfRequest('GET', '/sobjects/Case/describe');

  const picklists = {};
  for (const field of describe.fields || []) {
    if (PICKLIST_FIELDS.includes(field.name) && field.picklistValues?.length) {
      picklists[field.name] = field.picklistValues
        .filter(v => v.active)
        .map(v => ({ label: v.label, value: v.value, validFor: null }));
    }
  }

  const result = { picklists, dependencies: {} };
  describeCache.data      = result;
  describeCache.expiresAt = Date.now() + 60 * 60 * 1000;

  console.log('📋 Picklist values (describe fallback) cacheados:', Object.keys(picklists).length, 'campos.');
  return result;
}

async function actualizarCase(id, payload) {
  // Strip empty values
  const clean = Object.fromEntries(
    Object.entries(payload).filter(([, v]) => v !== '' && v !== null && v !== undefined)
  );
  await sfRequest('PATCH', `/sobjects/Case/${id}`, clean, AUTO_ASSIGN_HEADER);
  console.log(`✏️ Case ${id} actualizado en SF.`);
  return { success: true };
}

async function cerrarCase(id, resolucion, subetapaResuelto) {
  if (!resolucion || !resolucion.trim()) {
    throw new Error('La resolución es obligatoria para cerrar el caso.');
  }
  if (!subetapaResuelto) {
    throw new Error('Debes seleccionar una subetapa de resolución.');
  }
  await sfRequest('PATCH', `/sobjects/Case/${id}`, {
    Status: 'Resuelto',
    Subetapa_resuelto__c: subetapaResuelto,
  }, AUTO_ASSIGN_HEADER);
  console.log(`🔒 Case ${id} resuelto en SF (subetapa: ${subetapaResuelto}).`);
  return { success: true };
}

// ── Case Files / Internal Comments ───────────────────────────────────────────

function normalizeBase64Data(data, mimetype) {
  if (Buffer.isBuffer(data)) {
    if (!hasMagicBytes(data, mimetype)) throw new Error(`El contenido del archivo no coincide con el tipo declarado: ${mimetype}.`);
    return data.toString('base64');
  }
  if (typeof data !== 'string') throw new Error('El archivo debe recibirse como base64 o Buffer.');
  const normalized = normalizeBase64(data, mimetype);
  if (!hasMagicBytes(normalized.buffer, mimetype)) throw new Error(`El contenido del archivo no coincide con el tipo declarado: ${mimetype}.`);
  return normalized.data;
}

async function uploadFileToCase(caseId, { data, filename, mimetype }) {
  if (!caseId) throw new Error('caseId is required.');
  if (!data) throw new Error('file data is required.');
  const safeMimetype = String(mimetype || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIMETYPES.has(safeMimetype)) throw new Error(`Unsupported Salesforce file type: ${safeMimetype || 'unknown'}.`);

  const safeFilename = sanitizeFilename(filename, safeMimetype);
  const title = safeFilename.replace(/\.[^.]+$/, '') || 'whatsapp-media';
  const payload = {
    Title: title,
    PathOnClient: safeFilename,
    VersionData: normalizeBase64Data(data, safeMimetype),
    FirstPublishLocationId: caseId,
  };

  const created = await sfRequest('POST', '/sobjects/ContentVersion', payload);
  const versionId = created?.id;
  if (!versionId) throw new Error('Salesforce no retornó ContentVersion.Id.');

  const version = await sfRequest(
    'GET',
    `/sobjects/ContentVersion/${versionId}?fields=Id,ContentDocumentId,Title,PathOnClient`
  );

  return {
    contentVersionId: versionId,
    contentDocumentId: version?.ContentDocumentId || null,
    title: version?.Title || title,
    pathOnClient: version?.PathOnClient || payload.PathOnClient,
  };
}

async function createCaseComment(caseId, body) {
  if (!caseId) throw new Error('caseId is required.');
  if (!body || !String(body).trim()) throw new Error('CommentBody is required.');

  const created = await sfRequest('POST', '/sobjects/CaseComment', {
    ParentId: caseId,
    CommentBody: String(body),
    IsPublished: false,
  });

  return { id: created?.id, success: !!created?.success };
}

function __setTokenCacheForTests({ accessToken = 'test-token', expiresAt = Date.now() + 60000 } = {}) {
  tokenCache.accessToken = accessToken;
  tokenCache.expiresAt = expiresAt;
}

function __resetCachesForTests() {
  tokenCache = { accessToken: null, expiresAt: 0, idUrl: null, ownerInfo: null };
  describeCache = { data: null, expiresAt: 0 };
}

async function asignarmeCase(id) {
  const owner = await getOwnerInfo();
  if (!owner?.userId) throw new Error('No se pudo obtener el ID del analista autenticado.');
  await sfRequest('PATCH', `/sobjects/Case/${id}`, {
    OwnerId                    : owner.userId,
    Agente_due_o_del_ticket__c : owner.userId,
  }, AUTO_ASSIGN_HEADER);
  console.log(`👤 Case ${id} asignado a ${owner.displayName}.`);
  return { success: true, userId: owner.userId, displayName: owner.displayName };
}

// ── Account Lookup (SOQL) ────────────────────────────────────────────────────

async function buscarCuentas(texto) {
  const term = normalizeAccountSearchText(texto);
  if (term.length < 3) return [];
  const soql = `SELECT Id, Name FROM Account WHERE Name LIKE '%${term}%' LIMIT 5`;
  const data  = await sfRequest('GET', `/query?q=${encodeURIComponent(soql)}`);
  return (data?.records || []).map(r => ({ id: r.Id, name: r.Name }));
}

function normalizeAccountSearchText(texto) {
  const term = String(texto || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (term.length > 80) {
    const err = new Error('Account search text is too long.');
    err.statusCode = 400;
    throw err;
  }
  if (term && !/^[\p{L}\p{N} .&-]+$/u.test(term)) {
    const err = new Error('Account search text contains unsupported characters.');
    err.statusCode = 400;
    throw err;
  }
  return term;
}

module.exports = {
  SF_REQUEST_TIMEOUT_MS,
  sfRequest,
  DEFAULT_PRIVATE_KEY_PATH,
  resolveSalesforcePrivateKey,
  getToken,
  getOwnerInfo,
  crearCase,
  obtenerCase,
  getCaseCloseState,
  closeCaseFromOutbox,
  getDescribe,
  actualizarCase,
  cerrarCase,
  uploadFileToCase,
  createCaseComment,
  asignarmeCase,
  buscarCuentas,
  normalizeAccountSearchText,
  buildSafeSalesforceErrorMessage,
  createSalesforceError,
  __setTokenCacheForTests,
  __resetCachesForTests,
};
