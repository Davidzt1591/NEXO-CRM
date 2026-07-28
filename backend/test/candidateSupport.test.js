const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildCandidateGuidance, DEFAULT_GUIDANCE_MESSAGE, sendCandidateGuidanceIfAllowed } = require('../src/services/candidateSupport');
const { CandidateQuarantine } = require('../src/services/candidateQuarantine');

test('candidate guidance has a safe blank-URL fallback', () => {
  assert.equal(buildCandidateGuidance({ formUrl: '', message: '' }), DEFAULT_GUIDANCE_MESSAGE);
});

test('candidate guidance accepts only credential-free HTTPS URLs', () => {
  assert.doesNotMatch(buildCandidateGuidance({ formUrl: 'javascript:alert(1)', message: 'Help' }), /Formulario:/);
  assert.doesNotMatch(buildCandidateGuidance({ formUrl: 'https://user:secret@example.test/form', message: 'Help' }), /Formulario:/);
  assert.match(buildCandidateGuidance({ formUrl: 'https://example.test/form', message: 'Help' }), /https:\/\/example\.test\/form/);
});

for (const finalizeBehavior of ['throw', 'false']) {
  test(`candidate guidance retains its claim when finalize ${finalizeBehavior}s`, async () => {
    let claimed = false; let releases = 0; let replies = 0;
    const db = {
      getCandidateSupportSettings: async () => ({}),
      claimCandidateGuidance: async () => claimed ? null : (claimed = true, 'token'),
      finalizeCandidateGuidance: async () => {
        if (finalizeBehavior === 'throw') throw new Error('finalize unavailable');
        return false;
      },
      releaseCandidateGuidance: async () => { releases += 1; claimed = false; },
    };
    const message = { reply: async () => { replies += 1; } };
    await assert.rejects(() => sendCandidateGuidanceIfAllowed({ db, message, chatId: '573001112233@c.us' }));
    assert.equal(releases, 0);
    assert.equal(await sendCandidateGuidanceIfAllowed({ db, message, chatId: '573001112233@c.us' }), false);
    assert.equal(replies, 1);
  });
}

test('candidate guidance releases its claim only when reply delivery fails', async () => {
  let claimed = false; let releases = 0;
  const db = {
    getCandidateSupportSettings: async () => ({}),
    claimCandidateGuidance: async () => claimed ? null : (claimed = true, 'token'),
    finalizeCandidateGuidance: async () => true,
    releaseCandidateGuidance: async () => { releases += 1; claimed = false; return true; },
  };
  await assert.rejects(() => sendCandidateGuidanceIfAllowed({ db, message: { reply: async () => { throw new Error('reply failed'); } }, chatId: '573001112233@c.us' }), /reply failed/);
  assert.equal(releases, 1);
  assert.equal(await sendCandidateGuidanceIfAllowed({ db, message: { reply: async () => {} }, chatId: '573001112233@c.us' }), true);
});

test('failed database marking remains blocked after quarantine reload and never stores the raw chat ID', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexo-candidate-quarantine-'));
  t.after(() => fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }));
  const filePath = path.join(directory, 'quarantine.json');
  const chatId = '573001112233@c.us';
  const options = { filePath, serviceRoleKey: 'test-service-role-key-with-sufficient-entropy' };
  await new CandidateQuarantine(options).add(chatId);
  await assert.rejects(async () => { throw new Error('database mark failed'); }, /database mark failed/);
  assert.equal(await new CandidateQuarantine(options).has(chatId), true);
  const stored = await fs.readFile(filePath, 'utf8');
  assert.equal(stored.includes(chatId), false);
  assert.match(stored, /[0-9a-f]{64}/);
});

test('candidate quarantine refuses hashing without the service role key', async () => {
  const quarantine = new CandidateQuarantine({ filePath: 'unused', serviceRoleKey: '' });
  await assert.rejects(() => quarantine.add('573001112233@c.us'), { code: 'CANDIDATE_QUARANTINE_KEY_UNAVAILABLE' });
});
