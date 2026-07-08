const test = require('node:test');
const assert = require('node:assert/strict');

const adminOnly = require('../src/middleware/adminOnly');

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('adminOnly allows admins', () => {
  const req = { user: { role: 'admin' } };
  const res = createResponse();
  let called = false;

  adminOnly(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});

test('adminOnly rejects non-admins', () => {
  const req = { user: { role: 'agent' } };
  const res = createResponse();
  let called = false;

  adminOnly(req, res, () => { called = true; });

  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Administrator privileges are required.' });
});
