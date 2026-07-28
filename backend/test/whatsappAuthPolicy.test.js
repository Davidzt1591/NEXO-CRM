const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const os = require('node:os');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { assertLocalAuthOnly } = require('../src/services/whatsapp/authPolicy');

const repositoryRoot = path.resolve(__dirname, '../..');
const forbiddenName = ['Remote', 'Auth'].join('');

function productionJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'test', 'frontend', '.git', '.runtime'].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionJavaScriptFiles(target);
    return entry.isFile() && /\.(?:c?js|mjs)$/.test(entry.name) ? [target] : [];
  });
}

test('accepts the default and explicit LocalAuth strategy', () => {
  assert.equal(assertLocalAuthOnly({}), 'local');
  assert.equal(assertLocalAuthOnly({ WHATSAPP_AUTH_STRATEGY: 'LOCAL' }), 'local');
});

test('fails closed for unsupported auth strategies', () => {
  assert.throws(() => assertLocalAuthOnly({ WHATSAPP_AUTH_STRATEGY: forbiddenName }), /Unsupported WhatsApp auth strategy.*LocalAuth only/);
});

test('production sources never import or instantiate the unsupported strategy', () => {
  const violations = productionJavaScriptFiles(repositoryRoot).filter((file) => fs.readFileSync(file, 'utf8').includes(forbiddenName));
  assert.deepEqual(violations, []);
});

test('real Client retains the real LocalAuth strategy and sentinel data path without connecting', () => {
  const dataPath = path.join(os.tmpdir(), 'nexo-localauth-sentinel');
  const client = new Client({ authStrategy: new LocalAuth({ dataPath }) });
  assert.ok(client.authStrategy instanceof LocalAuth);
  assert.equal(client.authStrategy.dataPath, path.resolve(dataPath));
});
