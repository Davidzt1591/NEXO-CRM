const test = require('node:test');
const assert = require('node:assert/strict');

const { chunkTranscriptForCaseComments, compileTranscript, closeTicket, MAX_CASE_COMMENT_BYTES } = require('../src/services/ticketClose');

test('chunkTranscriptForCaseComments keeps CaseComment chunks under Salesforce byte limit', () => {
  const transcript = 'á'.repeat(3000) + '\n' + 'x'.repeat(3000);
  const chunks = chunkTranscriptForCaseComments(transcript);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= MAX_CASE_COMMENT_BYTES);
    assert.match(chunk, /^Transcripción NEXO \(parte \d+\/\d+\)/);
  }
});

test('compileTranscript formats stored messages without media binaries', () => {
  const transcript = compileTranscript({ id: 7, sf_case_number: '00001001', telefono: '57300' }, [
    { timestamp: '2026-07-10T10:00:00.000Z', from_user: true, body: 'Hola' },
    { timestamp: '2026-07-10T10:01:00.000Z', from_user: false, is_bot: true, body: 'Respuesta' },
  ]);

  assert.match(transcript, /Ticket 7/);
  assert.match(transcript, /Caso Salesforce: 00001001/);
  assert.match(transcript, /Cliente: Hola/);
  assert.match(transcript, /Bot: Respuesta/);
});

test('closeTicket enqueues Salesforce close outbox before local close without real Salesforce calls', async () => {
  const calls = [];
  const audits = [];
  let outboxJob;
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001', sf_case_number: '0001', telefono: '57300' }),
    getTranscriptMessages: async () => { throw new Error('transcript should not be loaded for outbox close'); },
    createSalesforceOutboxJob: async job => { outboxJob = job; calls.push(['outbox', job.operation]); return { id: 99, ...job }; },
    closeTicket: async id => { calls.push(['local-close', id]); return { id, status: 'closed' }; },
    saveMessage: async () => null,
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  };
  const mockSf = {
    createCaseComment: async () => { throw new Error('real Salesforce comment should not be called'); },
    cerrarCase: async () => { throw new Error('real Salesforce close should not be called'); },
  };

  const result = await closeTicket({ ticketId: 7, actor: { name: 'Admin', role: 'admin' }, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'ok', subetapa_resuelto: 'Solucionado' });

  assert.equal(result.salesforceStatus, 'pending');
  assert.equal(result.salesforceCloseStatus, 'pending');
  assert.equal(result.salesforceOutboxStatus, 'pending');
  assert.equal(result.transcriptStatus, 'skipped');
  assert.deepEqual(calls.map(call => call[0]), ['outbox', 'local-close']);
  assert.equal(outboxJob.operation, 'case_close');
  assert.equal(outboxJob.status, 'pending');
  assert.equal(outboxJob.sf_case_id, '500xx000001');
  assert.match(outboxJob.idempotency_key, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(outboxJob.payload), /ok/);
  assert.equal(result.salesforceOutboxJob.id, 99);
  assert.equal(result.salesforceOutboxJob.status, 'pending');
  assert.equal(audits[0].action, 'ticket.closed');
  assert.equal(audits[0].metadata.salesforce_outbox_status, 'pending');
  assert.equal(audits[0].metadata.transcript, undefined);
});

test('closeTicket preserves local close when Salesforce transcript fails', async () => {
  let localClosed = false;
  const audits = [];
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001' }),
    getTranscriptMessages: async () => [{ body: 'secret transcript' }],
    closeTicket: async () => { localClosed = true; },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  };
  const mockSf = {
    createCaseComment: async () => { throw new Error('sf unavailable'); },
  };

  const result = await closeTicket({ ticketId: 8, db: mockDb, sf: mockSf });

  assert.equal(localClosed, true);
  assert.equal(result.salesforceStatus, 'failed');
  assert.equal(result.transcriptStatus, 'failed');
  assert.equal(audits[0].action, 'ticket.close_sf_failed');
  assert.equal(audits[0].metadata.error, 'sf unavailable');
});

test('closeTicket does not close local ticket when Salesforce outbox enqueue fails', async () => {
  let localClosed = false;
  const audits = [];
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001' }),
    createSalesforceOutboxJob: async () => {
      const err = new Error('Salesforce outbox schema is not available.');
      err.statusCode = 503;
      err.code = 'SF_OUTBOX_SCHEMA_MISSING';
      throw err;
    },
    closeTicket: async () => { localClosed = true; },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  };
  const mockSf = {
    createCaseComment: async () => { throw new Error('real Salesforce should not be called'); },
    cerrarCase: async () => { throw new Error('real Salesforce should not be called'); },
  };

  await assert.rejects(
    closeTicket({ ticketId: 11, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'ok', subetapa_resuelto: 'Solucionado' }),
    err => err.statusCode === 503 && err.code === 'SF_OUTBOX_SCHEMA_MISSING'
  );
  assert.equal(localClosed, false);
  assert.equal(audits[0].action, 'ticket.close_sf_outbox_failed');
  assert.equal(audits[0].metadata.salesforce_close_status, 'failed');
  assert.equal(audits[0].metadata.salesforce_outbox_status, 'failed');
});

test('closeTicket maps generic Salesforce outbox enqueue failures to a controlled code before local close', async () => {
  let localClosed = false;
  const audits = [];
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001' }),
    createSalesforceOutboxJob: async () => {
      const err = new Error('duplicate key value violates unique constraint salesforce_outbox_idempotency_key_key');
      err.statusCode = 409;
      err.code = '23505';
      throw err;
    },
    closeTicket: async () => { localClosed = true; },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  };
  const mockSf = {
    createCaseComment: async () => { throw new Error('real Salesforce should not be called'); },
    cerrarCase: async () => { throw new Error('real Salesforce should not be called'); },
  };

  await assert.rejects(
    closeTicket({ ticketId: 13, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'ok', subetapa_resuelto: 'Solucionado' }),
    err => err.statusCode === 502 &&
      err.code === 'SF_OUTBOX_ENQUEUE_FAILED' &&
      !/duplicate key|23505|salesforce_outbox_idempotency_key/i.test(err.message)
  );
  assert.equal(localClosed, false);
  assert.equal(audits[0].action, 'ticket.close_sf_outbox_failed');
  assert.equal(audits[0].metadata.error_code, '23505');
});

test('closeTicket uses a deterministic outbox idempotency key for duplicate close requests', async () => {
  const idempotencyKeys = [];
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001' }),
    createSalesforceOutboxJob: async job => {
      idempotencyKeys.push(job.idempotency_key);
      return { id: idempotencyKeys.length, ...job, duplicate: idempotencyKeys.length > 1 };
    },
    closeTicket: async id => ({ id, status: 'closed' }),
    logAudit: async () => null,
  };
  const mockSf = {
    createCaseComment: async () => { throw new Error('real Salesforce should not be called'); },
    cerrarCase: async () => { throw new Error('real Salesforce should not be called'); },
  };

  const first = await closeTicket({ ticketId: 12, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'ok', subetapa_resuelto: 'Solucionado' });
  const second = await closeTicket({ ticketId: 12, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'different private details', subetapa_resuelto: 'Solucionado' });

  assert.equal(first.salesforceOutboxStatus, 'pending');
  assert.equal(second.salesforceOutboxStatus, 'pending');
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
  assert.equal(second.salesforceOutboxJob.id, 2);
});

test('closeTicket validates Salesforce close fields before local mutation', async () => {
  let localClosed = false;
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001' }),
    closeTicket: async () => { localClosed = true; },
  };

  await assert.rejects(
    closeTicket({ ticketId: 9, db: mockDb, closeSalesforce: true, resolucion: 'ok' }),
    /subetapa/
  );
  assert.equal(localClosed, false);
});

test('closeTicket does not audit success when local close fails', async () => {
  const audits = [];
  const mockDb = {
    getTicketById: async id => ({ id }),
    closeTicket: async () => { throw new Error('supabase update failed'); },
    logAudit: async payload => { audits.push(payload); },
  };

  await assert.rejects(
    closeTicket({ ticketId: 10, db: mockDb }),
    /supabase update failed/
  );
  assert.equal(audits.length, 0);
});
