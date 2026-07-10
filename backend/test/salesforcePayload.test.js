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

test('normalizeAccountSearchText rejects SOQL injection-like characters and length', () => {
  assert.equal(salesforce.normalizeAccountSearchText('  ACME   Colombia-1  '), 'ACME Colombia-1');
  assert.throws(() => salesforce.normalizeAccountSearchText('ACME_1'), /unsupported characters/);
  assert.throws(() => salesforce.normalizeAccountSearchText("ACME' OR Name LIKE '%"), /unsupported characters/);
  assert.throws(() => salesforce.normalizeAccountSearchText('a'.repeat(81)), /too long/);
});
