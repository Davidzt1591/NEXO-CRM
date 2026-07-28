const test = require('node:test');
const assert = require('node:assert/strict');
const { processBatch, serialize } = require('../src/services/ticketPostProcessing');

function harness(fail = null) {
  const calls = { outbox: 0, emits: 0, deletes: 0, finalized: [], attemptsStarted: [] };
  const row = { ticket_id: 7, chat_id: '573001112233@c.us', salesforce_outbox_status: 'pending', operational_emit_status: 'pending', session_cleanup_status: 'pending' };
  const db = {
    claimTicketPostProcessing: async () => [row], getTicketById: async () => ({ id: 7, area_id: 2, status: 'open' }),
    createSalesforceOutboxJob: async () => { calls.outbox++; if (fail === 'salesforce_outbox') throw Object.assign(new Error('down'), { code: 'OUTBOX_DOWN' }); },
    deleteSession: async () => { calls.deletes++; if (fail === 'session_cleanup') throw Object.assign(new Error('down'), { code: 'SESSION_DOWN' }); },
    markTicketPostProcessingAttemptStarted: async (...args) => { calls.attemptsStarted.push(args); return true; },
    finalizeTicketPostProcessingEffect: async (...args) => { calls.finalized.push(args); return true; },
  };
  const target = { to: () => target, emit: () => { calls.emits++; if (fail === 'operational_emit') throw Object.assign(new Error('down'), { code: 'EMIT_DOWN' }); } };
  const io = { to: () => target };
  return { db, io, calls };
}

test('processor independently finalizes recoverable effects and reports per-item failures', async () => {
  for (const effect of ['salesforce_outbox', 'operational_emit', 'session_cleanup']) {
    const h = harness(effect);
    const result = await processBatch({ ...h, limit: 1, workerId: '00000000-0000-4000-8000-000000000001' });
    assert.equal(result.claimed, 1);
    assert.equal(result.results[0].effects.find(item => item.effect === effect).status, effect === 'operational_emit' ? 'uncertain' : 'failed');
    assert.equal(h.calls.finalized.length, effect === 'operational_emit' ? 1 : 3);
  }
});

test('processor skips completed effects and outbox creation is delegated with stable ticket identity', async () => {
  const h = harness();
  h.db.claimTicketPostProcessing = async () => [{ ticket_id: 7, chat_id: '573001112233@c.us', salesforce_outbox_status: 'completed', operational_emit_status: 'completed', session_cleanup_status: 'pending' }];
  const result = await processBatch({ ...h, limit: 1 });
  assert.equal(result.results[0].effects.length, 1);
  assert.equal(h.calls.outbox, 0); assert.equal(h.calls.deletes, 1);
});

test('inspection serializer excludes chat and payload data', () => {
  const safe = serialize({ ticket_id: 7, submission_id: 'sub', chat_id: 'secret', payload: { secret: true }, whatsapp_ack_status: 'uncertain' });
  assert.equal(safe.chat_id, undefined); assert.equal(safe.payload, undefined); assert.equal(safe.whatsapp_ack_status, 'uncertain');
});

test('processor claims one row at a time and continues after isolated lookup failure', async () => {
  const h = harness();
  const rows = [
    { ticket_id: 7, chat_id: 'first@c.us', salesforce_outbox_status: 'pending', operational_emit_status: 'pending', session_cleanup_status: 'completed' },
    { ticket_id: 8, chat_id: 'second@c.us', salesforce_outbox_status: 'pending', operational_emit_status: 'completed', session_cleanup_status: 'completed' },
  ];
  const claimLimits = [];
  h.db.claimTicketPostProcessing = async (_workerId, limit) => {
    claimLimits.push(limit);
    return rows.length ? [rows.shift()] : [];
  };
  h.db.getTicketById = async id => {
    if (id === 7) throw Object.assign(new Error('lookup unavailable'), { code: 'LOOKUP_UNAVAILABLE' });
    return { id, area_id: 2, status: 'open' };
  };

  const result = await processBatch({ ...h, limit: 2 });
  assert.equal(result.claimed, 2);
  assert.deepEqual(claimLimits, [1, 1]);
  assert.equal(result.results[0].effects[0].error_code, 'LOOKUP_UNAVAILABLE');
  assert.equal(result.results[1].effects[0].status, 'completed');
});

test('processor reports lease loss when successful side effect cannot be finalized', async () => {
  const h = harness();
  h.db.finalizeTicketPostProcessingEffect = async () => false;
  const result = await processBatch({ ...h, limit: 1 });
  assert.deepEqual(result.results[0].effects, [{ effect: 'salesforce_outbox', status: 'lease_lost', error_code: 'LEASE_LOST' }]);
  assert.equal(h.calls.emits, 0);
  assert.equal(h.calls.deletes, 0);
});

test('side-effect timeout preserves uncertainty and does not finalize or claim another row', async () => {
  const h = harness();
  let claims = 0;
  h.db.claimTicketPostProcessing = async () => {
    claims += 1;
    return [{ ticket_id: claims, chat_id: 'chat@c.us', salesforce_outbox_status: 'pending', operational_emit_status: 'completed', session_cleanup_status: 'completed' }];
  };
  h.db.createSalesforceOutboxJob = async () => new Promise(() => {});
  const result = await processBatch({ ...h, limit: 2, deadlines: { lookup: 20, sideEffect: 5, finalize: 20 } });
  assert.equal(claims, 1);
  assert.equal(result.results[0].effects[0].status, 'uncertain');
  assert.equal(result.results[0].effects[0].error_code, 'SALESFORCE_OUTBOX_SIDE_EFFECT_TIMEOUT');
  assert.equal(h.calls.finalized.length, 0);
});

test('finalize timeout is uncertain and retains ownership instead of claiming more work', async () => {
  const h = harness();
  let claims = 0;
  h.db.claimTicketPostProcessing = async () => {
    claims += 1;
    return [{ ticket_id: 7, chat_id: 'chat@c.us', salesforce_outbox_status: 'pending', operational_emit_status: 'completed', session_cleanup_status: 'completed' }];
  };
  h.db.finalizeTicketPostProcessingEffect = async () => new Promise(() => {});
  const result = await processBatch({ ...h, limit: 2, deadlines: { lookup: 20, sideEffect: 20, finalize: 5 } });
  assert.equal(claims, 1);
  assert.equal(result.results[0].effects[0].status, 'uncertain');
  assert.equal(result.results[0].effects[0].error_code, 'SALESFORCE_OUTBOX_FINALIZE_TIMEOUT');
});

test('operational emit is durably marked uncertain before invocation and confirmed success finalizes it', async () => {
  const h = harness();
  const result = await processBatch({ ...h, limit: 1, workerId: '00000000-0000-4000-8000-000000000001' });
  assert.deepEqual(h.calls.attemptsStarted, [[7, '00000000-0000-4000-8000-000000000001', 'operational_emit']]);
  assert.equal(h.calls.emits, 2);
  assert.equal(result.results[0].effects.find(effect => effect.effect === 'operational_emit').status, 'completed');
  assert.deepEqual(h.calls.finalized.find(args => args[2] === 'operational_emit'), [7, '00000000-0000-4000-8000-000000000001', 'operational_emit', true]);
});

test('operational mark-attempt failure invokes no emit', async () => {
  const h = harness();
  h.db.markTicketPostProcessingAttemptStarted = async () => false;
  const result = await processBatch({ ...h, limit: 1 });
  assert.equal(h.calls.emits, 0);
  assert.equal(result.results[0].effects.find(effect => effect.effect === 'operational_emit').status, 'attempt_start_failed');
});

test('operational timeout remains durably uncertain after lease expiry and is not invoked twice', async () => {
  const h = harness();
  let durableStatus = 'pending';
  let emits = 0;
  h.db.claimTicketPostProcessing = async () => durableStatus === 'uncertain' ? [] : [{
    ticket_id: 7, chat_id: 'chat@c.us', salesforce_outbox_status: 'completed',
    operational_emit_status: durableStatus, session_cleanup_status: 'completed',
  }];
  h.db.markTicketPostProcessingAttemptStarted = async () => { durableStatus = 'uncertain'; return true; };
  const target = { to: () => target, emit: () => {
    emits += 1;
    throw Object.assign(new Error('emit timed out'), { code: 'OPERATIONAL_EMIT_SIDE_EFFECT_TIMEOUT', isTimeout: true });
  } };
  h.io = { to: () => target };

  const first = await processBatch({ ...h, limit: 1, deadlines: { lookup: 20, sideEffect: 5, finalize: 20 } });
  assert.equal(first.results[0].effects[0].status, 'uncertain');
  assert.equal(durableStatus, 'uncertain');
  const afterLeaseExpiry = await processBatch({ ...h, limit: 1 });
  assert.equal(afterLeaseExpiry.claimed, 0);
  assert.equal(emits, 1);
});

test('a durable uncertain operational emit is inspected without reinvocation while safe cleanup retries', async () => {
  const h = harness();
  h.db.claimTicketPostProcessing = async () => [{
    ticket_id: 7, chat_id: 'chat@c.us', salesforce_outbox_status: 'completed',
    operational_emit_status: 'uncertain', session_cleanup_status: 'pending',
  }];
  const result = await processBatch({ ...h, limit: 1 });
  assert.equal(h.calls.emits, 0);
  assert.equal(h.calls.deletes, 1);
  assert.deepEqual(result.results[0].effects[0], {
    effect: 'operational_emit', status: 'uncertain', error_code: 'OPERATIONAL_EMIT_UNCERTAIN',
  });
});
