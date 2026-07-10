const test = require('node:test');
const assert = require('node:assert/strict');

const { validateWhatsAppMedia } = require('../src/services/mediaValidation');

test('validateWhatsAppMedia accepts allowed WhatsApp media and returns metadata', () => {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64');
  const result = validateWhatsAppMedia({ data, mimetype: 'image/jpeg', filename: '../photo 💣.jpg' });

  assert.equal(result.mimetype, 'image/jpeg');
  assert.equal(result.filename, '-photo _.jpg');
  assert.equal(result.sizeBytes, 4);
  assert.equal(result.data, data);
});

test('validateWhatsAppMedia rejects unsupported mimetypes', () => {
  assert.throws(
    () => validateWhatsAppMedia({ data: Buffer.from('x').toString('base64'), mimetype: 'text/html' }),
    /Unsupported WhatsApp media type/
  );
});

test('validateWhatsAppMedia rejects audio and video types without signature support', () => {
  const spoofedPayload = Buffer.from('spoofed-media').toString('base64');
  for (const mimetype of [
    'audio/mpeg',
    'audio/ogg',
    'audio/webm',
    'video/mp4',
    'video/webm',
    'video/quicktime',
  ]) {
    assert.throws(
      () => validateWhatsAppMedia({ data: spoofedPayload, mimetype }),
      /Unsupported WhatsApp media type.*Supported WhatsApp media types/
    );
  }
});

test('validateWhatsAppMedia rejects oversized decoded payloads', () => {
  const data = Buffer.alloc(6).toString('base64');
  const exact = Buffer.from('%PDF-').toString('base64');

  assert.equal(
    validateWhatsAppMedia({ data: exact, mimetype: 'application/pdf' }, { maxBytes: 5 }).sizeBytes,
    5
  );
  assert.throws(
    () => validateWhatsAppMedia({ data, mimetype: 'application/pdf' }, { maxBytes: 5 }),
    /exceeds 5 bytes/
  );
});

test('validateWhatsAppMedia rejects malformed and empty base64', () => {
  assert.throws(
    () => validateWhatsAppMedia({ data: 'not@@base64', mimetype: 'application/pdf' }),
    /strict base64/
  );
  assert.throws(
    () => validateWhatsAppMedia({ data: '', mimetype: 'application/pdf' }),
    /base64 string/
  );
});

test('validateWhatsAppMedia strips safe data URLs and rejects mismatched prefixes', () => {
  const pdf = Buffer.from('%PDF-1.7').toString('base64');
  const result = validateWhatsAppMedia({ data: `data:application/pdf;base64,${pdf}`, mimetype: 'application/pdf' });

  assert.equal(result.data, pdf);
  assert.throws(
    () => validateWhatsAppMedia({ data: `data:text/html;base64,${pdf}`, mimetype: 'application/pdf' }),
    /mimetype does not match/
  );
});

test('validateWhatsAppMedia enforces magic bytes for common file types', () => {
  assert.throws(
    () => validateWhatsAppMedia({ data: Buffer.from('fake-pdf').toString('base64'), mimetype: 'application/pdf', filename: 'x.pdf' }),
    /does not match declared type/
  );

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  assert.equal(validateWhatsAppMedia({ data: png, mimetype: 'image/png' }).sizeBytes, 8);
});

test('validateWhatsAppMedia validates webp RIFF/WEBP signature', () => {
  assert.throws(
    () => validateWhatsAppMedia({ data: Buffer.from('fake-webp').toString('base64'), mimetype: 'image/webp' }),
    /does not match declared type/
  );

  const webp = Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary').toString('base64');
  assert.equal(validateWhatsAppMedia({ data: webp, mimetype: 'image/webp' }).sizeBytes, 12);
});
