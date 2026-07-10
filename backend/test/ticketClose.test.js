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

test('closeTicket writes transcript comments before local close and audits success', async () => {
  const calls = [];
  const audits = [];
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001', sf_case_number: '0001', telefono: '57300' }),
    getTranscriptMessages: async () => [{ timestamp: 't', from_user: true, body: 'hello' }],
    closeTicket: async id => calls.push(['local-close', id]),
    saveMessage: async () => null,
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  };
  const comments = [];
  const mockSf = {
    createCaseComment: async (caseId, body) => { comments.push({ caseId, body }); calls.push(['comment', caseId]); },
    cerrarCase: async () => { calls.push(['sf-close']); },
  };

  const result = await closeTicket({ ticketId: 7, actor: { name: 'Admin', role: 'admin' }, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'ok', subetapa_resuelto: 'Solucionado' });

  assert.equal(result.salesforceStatus, 'success');
  assert.deepEqual(calls.map(call => call[0]), ['comment', 'sf-close', 'local-close']);
  assert.equal(comments.length, 1);
  assert.equal(audits[0].action, 'ticket.closed');
  assert.equal(audits[0].metadata.message_count, 1);
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

test('closeTicket does not close local ticket when requested Salesforce close fails', async () => {
  let localClosed = false;
  const audits = [];
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001' }),
    getTranscriptMessages: async () => [{ body: 'hello' }],
    closeTicket: async () => { localClosed = true; },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  };
  const mockSf = {
    createCaseComment: async () => null,
    cerrarCase: async () => { throw new Error('sf close failed'); },
  };

  await assert.rejects(
    closeTicket({ ticketId: 11, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'ok', subetapa_resuelto: 'Solucionado' }),
    err => err.message === 'sf close failed' && err.statusCode === 502 && err.code === 'SF_CLOSE_FAILED'
  );
  assert.equal(localClosed, false);
  assert.equal(audits[0].action, 'ticket.close_sf_failed');
  assert.equal(audits[0].metadata.salesforce_close_status, 'failed');
});

test('closeTicket treats transcript failure as non-fatal when requested Salesforce close succeeds', async () => {
  let localClosed = false;
  const mockDb = {
    getTicketById: async id => ({ id, sf_case_id: '500xx000001' }),
    getTranscriptMessages: async () => [{ body: 'hello' }],
    closeTicket: async () => { localClosed = true; },
    logAudit: async () => null,
  };
  const mockSf = {
    createCaseComment: async () => { throw new Error('comment failed'); },
    cerrarCase: async () => null,
  };

  const result = await closeTicket({ ticketId: 12, db: mockDb, sf: mockSf, closeSalesforce: true, resolucion: 'ok', subetapa_resuelto: 'Solucionado' });

  assert.equal(localClosed, true);
  assert.equal(result.salesforceStatus, 'success');
  assert.equal(result.salesforceCloseStatus, 'success');
  assert.equal(result.transcriptStatus, 'failed');
  assert.equal(result.transcriptError, 'comment failed');
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
