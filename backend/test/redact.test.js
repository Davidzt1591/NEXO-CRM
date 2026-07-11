const test = require('node:test');
const assert = require('node:assert/strict');
const { redactForLog, redactLogArgs, redactTextForLog, safeStringifyForLog } = require('../src/utils/redact');

test('redactForLog removes obvious secrets and PII from Salesforce Case payloads', () => {
  const redacted = redactForLog({
    Subject: 'Support request',
    SuppliedEmail: 'person@example.com',
    SuppliedPhone: '+57 300 123 4567',
    DocumentNumber: '1234567890',
    Description: 'A'.repeat(140),
    authorization: 'Bearer super-secret-token',
    CLIENT_SECRET: 'secret-value',
  });

  assert.equal(redacted.Subject, 'Support request');
  assert.equal(redacted.SuppliedEmail, '[REDACTED]');
  assert.equal(redacted.SuppliedPhone, '[REDACTED]');
  assert.equal(redacted.DocumentNumber, '[REDACTED]');
  assert.match(redacted.Description, /\[TRUNCATED\]/);
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.CLIENT_SECRET, '[REDACTED]');
});

test('redactTextForLog redacts inline bearer tokens, emails, phones, and query secrets', () => {
  const text = redactTextForLog('Authorization: Bearer abc.def email user@example.com phone +1 555 123 4567 url https://x.test/path?token=secret');

  assert.doesNotMatch(text, /abc\.def/);
  assert.doesNotMatch(text, /user@example\.com/);
  assert.doesNotMatch(text, /555 123 4567/);
  assert.doesNotMatch(text, /secret/);
  assert.match(text, /\[REDACTED\]/);
});

test('safeStringifyForLog handles circular objects without leaking sensitive fields', () => {
  const value = { email: 'person@example.com', nested: {} };
  value.nested.self = value;

  const serialized = safeStringifyForLog(value);

  assert.doesNotMatch(serialized, /person@example\.com/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /\[Circular\]/);
});

test('redactForLog handles self-referential arrays without recursing forever', () => {
  const value = ['person@example.com'];
  value.push(value);

  const redacted = redactForLog(value);

  assert.equal(redacted[0], '[REDACTED]');
  assert.equal(redacted[1], '[Circular]');
});

test('redactLogArgs handles mixed circular objects and arrays', () => {
  const object = { token: 'secret-token' };
  object.self = object;
  const array = [];
  array.push(array);

  const [safeObject, safeArray] = redactLogArgs([object, array]);

  assert.equal(safeObject.token, '[REDACTED]');
  assert.equal(safeObject.self, '[Circular]');
  assert.equal(safeArray[0], '[Circular]');
});
