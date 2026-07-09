const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const salesforce = require('../src/services/salesforce');

function fsStub(files = {}) {
  return {
    existsSync: filePath => Object.prototype.hasOwnProperty.call(files, path.resolve(filePath)),
    readFileSync: filePath => files[path.resolve(filePath)],
  };
}

test('resolveSalesforcePrivateKey prefers env private key content', () => {
  const result = salesforce.resolveSalesforcePrivateKey({
    SALESFORCE_PRIVATE_KEY: 'line1\\nline2',
  }, fsStub());

  assert.equal(result.source, 'SALESFORCE_PRIVATE_KEY');
  assert.equal(result.privateKey, 'line1\nline2');
});

test('resolveSalesforcePrivateKey supports configured untracked private key path', () => {
  const keyPath = path.resolve('tmp-salesforce-test.key');
  const result = salesforce.resolveSalesforcePrivateKey({
    SALESFORCE_PRIVATE_KEY_PATH: keyPath,
  }, fsStub({ [keyPath]: 'test-private-key-content' }));

  assert.equal(result.source, 'SALESFORCE_PRIVATE_KEY_PATH');
  assert.equal(result.privateKey, 'test-private-key-content');
});

test('resolveSalesforcePrivateKey falls back to default local key path only when present', () => {
  const result = salesforce.resolveSalesforcePrivateKey({}, fsStub({
    [salesforce.DEFAULT_PRIVATE_KEY_PATH]: 'default-test-private-key-content',
  }));

  assert.equal(result.source, salesforce.DEFAULT_PRIVATE_KEY_PATH);
  assert.equal(result.privateKey, 'default-test-private-key-content');
});

test('resolveSalesforcePrivateKey returns null when no private key is configured', () => {
  assert.equal(salesforce.resolveSalesforcePrivateKey({}, fsStub()), null);
});
