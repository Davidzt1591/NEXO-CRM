const test = require('node:test');
const assert = require('node:assert/strict');

const salesforce = require('../src/services/salesforce');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

test('uploadFileToCase creates ContentVersion with FirstPublishLocationId and base64 payload', async (t) => {
  salesforce.__setTokenCacheForTests({ accessToken: 'mock-token' });
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (calls.length === 1) return response(201, { id: '068xx000001', success: true });
    return response(200, { Id: '068xx000001', ContentDocumentId: '069xx000001', Title: 'photo', PathOnClient: 'photo.jpg' });
  };
  t.after(() => { global.fetch = originalFetch; salesforce.__resetCachesForTests(); });

  const result = await salesforce.uploadFileToCase('500xx000001', {
    data: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64'),
    filename: '../photo 💣.jpg',
    mimetype: 'image/jpeg',
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/sobjects\/ContentVersion$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].body.FirstPublishLocationId, '500xx000001');
  assert.equal(calls[0].body.PathOnClient, '-photo _.jpg');
  assert.equal(calls[0].body.ContentType, undefined);
  assert.equal(result.contentDocumentId, '069xx000001');
});

test('uploadFileToCase rejects spoofed common file content', async () => {
  await assert.rejects(
    salesforce.uploadFileToCase('500xx000001', {
      data: Buffer.from('not a pdf').toString('base64'),
      filename: 'file.pdf',
      mimetype: 'application/pdf',
    }),
    /no coincide con el tipo declarado/
  );
});

test('createCaseComment builds private CaseComment payload', async (t) => {
  salesforce.__setTokenCacheForTests({ accessToken: 'mock-token' });
  const originalFetch = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return response(201, { id: '00axx000001', success: true });
  };
  t.after(() => { global.fetch = originalFetch; salesforce.__resetCachesForTests(); });

  const result = await salesforce.createCaseComment('500xx000001', 'internal transcript');

  assert.deepEqual(payload, {
    ParentId: '500xx000001',
    CommentBody: 'internal transcript',
    IsPublished: false,
  });
  assert.deepEqual(result, { id: '00axx000001', success: true });
});

test('Salesforce API errors log only status and normalized code', async (t) => {
  salesforce.__setTokenCacheForTests({ accessToken: 'mock-token' });
  const originalFetch = global.fetch;
  const originalError = console.error;
  const errorLogs = [];
  const rawMessage = 'Validation failed for person@example.com token=raw-token phone +57 300 123 4567';

  global.fetch = async () => response(400, [{ message: rawMessage, fields: ['SuppliedEmail'] }]);
  console.error = (...args) => { errorLogs.push(args.map(value => typeof value === 'object' ? JSON.stringify(value) : value).join(' ')); };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalError;
    salesforce.__resetCachesForTests();
  });

  await assert.rejects(
    salesforce.createCaseComment('500xx000001', 'internal transcript'),
    err => {
      assert.doesNotMatch(err.message, /person@example\.com/);
      assert.doesNotMatch(err.message, /raw-token/);
      assert.doesNotMatch(err.message, /300 123 4567/);
      assert.match(err.message, /400/);
      return true;
    }
  );

  const logText = errorLogs.join('\n');
  assert.doesNotMatch(logText, /person@example\.com/);
  assert.doesNotMatch(logText, /raw-token/);
  assert.doesNotMatch(logText, /300 123 4567/);
  assert.match(logText, /400/);
  assert.match(logText, /SF_HTTP_400/);
  assert.doesNotMatch(logText, /Validation failed|SuppliedEmail/);
});

test('sfRequest aborts within its bound and returns a retryable normalized timeout', async (t) => {
  salesforce.__setTokenCacheForTests({ accessToken: 'mock-token' });
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  t.after(() => { global.fetch = originalFetch; salesforce.__resetCachesForTests(); });

  await assert.rejects(
    salesforce.sfRequest('GET', '/sobjects/Case/500xx', null, {}, false, 5),
    err => err.statusCode === 408 && err.code === 'SF_REQUEST_TIMEOUT' && !/aborted/.test(err.message),
  );
});

test('sfRequest timeout remains active while the response body is being read', async (t) => {
  salesforce.__setTokenCacheForTests({ accessToken: 'mock-token' });
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => ({
    status: 200,
    ok: true,
    text: async () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('raw body secret'), { name: 'AbortError' })));
    }),
  });
  t.after(() => { global.fetch = originalFetch; salesforce.__resetCachesForTests(); });

  await assert.rejects(
    salesforce.sfRequest('GET', '/sobjects/Case/500xx', null, {}, false, 5),
    err => err.statusCode === 408 && err.code === 'SF_REQUEST_TIMEOUT' && !/raw body secret/.test(err.message),
  );
});

test('Salesforce close-state errors preserve safe HTTP status and normalized code', async (t) => {
  salesforce.__setTokenCacheForTests({ accessToken: 'mock-token' });
  const originalFetch = global.fetch;
  global.fetch = async () => response(422, [{ message: 'Invalid close state', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }]);
  t.after(() => { global.fetch = originalFetch; salesforce.__resetCachesForTests(); });

  await assert.rejects(
    salesforce.getCaseCloseState('500xx000001'),
    err => err.statusCode === 422 && err.code === 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  );
});

test('Salesforce empty error responses preserve HTTP status without raw content', async (t) => {
  salesforce.__setTokenCacheForTests({ accessToken: 'mock-token' });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 503, ok: false, text: async () => '' });
  t.after(() => { global.fetch = originalFetch; salesforce.__resetCachesForTests(); });

  await assert.rejects(
    salesforce.getCaseCloseState('500xx000001'),
    err => err.statusCode === 503 && err.code === 'SF_HTTP_503',
  );
});

test('normalizeAccountSearchText rejects SOQL injection-like characters and length', () => {
  assert.equal(salesforce.normalizeAccountSearchText('  ACME   Colombia-1  '), 'ACME Colombia-1');
  assert.throws(() => salesforce.normalizeAccountSearchText('ACME_1'), /unsupported characters/);
  assert.throws(() => salesforce.normalizeAccountSearchText("ACME' OR Name LIKE '%"), /unsupported characters/);
  assert.throws(() => salesforce.normalizeAccountSearchText('a'.repeat(81)), /too long/);
});
