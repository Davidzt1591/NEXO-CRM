const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const routePath = path.resolve(__dirname, '../src/routes/salesforce.js');
const dbPath = path.resolve(__dirname, '../src/database/db.js');
const sfPath = path.resolve(__dirname, '../src/services/salesforce.js');
const closePath = path.resolve(__dirname, '../src/services/ticketClose.js');

function validateSalesforceCloseFields({ resolucion, subetapa_resuelto }) {
  if (!resolucion?.trim()) {
    const err = new Error('La resolución es obligatoria para cerrar el caso.');
    err.statusCode = 400;
    throw err;
  }
  if (!subetapa_resuelto?.trim()) {
    const err = new Error('Debes seleccionar una subetapa de resolución.');
    err.statusCode = 400;
    throw err;
  }
}

function loadRouter({ mockDb, mockSf = {}, mockClose }) {
  delete require.cache[routePath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
  require.cache[sfPath] = { id: sfPath, filename: sfPath, loaded: true, exports: mockSf };
  require.cache[closePath] = { id: closePath, filename: closePath, loaded: true, exports: mockClose };
  return require(routePath);
}

async function withServer({ mockDb, mockSf, mockClose, user }, run) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/sf', loadRouter({ mockDb, mockSf, mockClose }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete require.cache[routePath];
    delete require.cache[dbPath];
    delete require.cache[sfPath];
    delete require.cache[closePath];
  }
}

async function postJson(baseUrl, pathname, body) {
  return requestJson(baseUrl, 'POST', pathname, body);
}

async function requestJson(baseUrl, method, pathname, body) {
  return await new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(new URL(pathname, baseUrl), {
      method,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Salesforce ticket-aware close rejects unauthorized non-admin before local close', async () => {
  let closeCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: null }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 3 }),
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => { closeCalled = true; },
  };

  await withServer({ mockDb, mockClose, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      ticket_id: 7,
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(res.status, 403);
    assert.equal(closeCalled, false);
  });
});

test('Salesforce ticket-aware close requires ticket_id before any Salesforce mutation', async () => {
  let sfCloseCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => { throw new Error('should not check ticket without ticket_id'); },
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    cerrarCase: async () => { sfCloseCalled = true; },
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => { throw new Error('should not close without ticket_id'); },
  };

  await withServer({ mockDb, mockSf, mockClose, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(res.status, 400);
    assert.equal(sfCloseCalled, false);
    assert.match(res.body.error, /ticket_id/);
  });
});

test('Salesforce ticket-aware close rejects unknown ticket_id before any Salesforce mutation', async () => {
  let sfCloseCalled = false;
  let localCloseCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => null,
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    cerrarCase: async () => { sfCloseCalled = true; },
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => { localCloseCalled = true; },
  };

  await withServer({ mockDb, mockSf, mockClose, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      ticket_id: 999,
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(res.status, 404);
    assert.equal(sfCloseCalled, false);
    assert.equal(localCloseCalled, false);
  });
});

test('Salesforce ticket-aware close rejects ticket without sf_case_id before local close', async () => {
  let sfCloseCalled = false;
  let localCloseCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: null, sf_case_id: null }),
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    cerrarCase: async () => { sfCloseCalled = true; },
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => { localCloseCalled = true; },
  };

  await withServer({ mockDb, mockSf, mockClose, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      ticket_id: 7,
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(res.status, 400);
    assert.equal(sfCloseCalled, false);
    assert.equal(localCloseCalled, false);
    assert.match(res.body.error, /Case de Salesforce asociado/);
  });
});

test('Salesforce ticket-aware close rejects URL Case ID mismatch before local close', async () => {
  let sfCloseCalled = false;
  let localCloseCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: null, sf_case_id: '500yy' }),
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    cerrarCase: async () => { sfCloseCalled = true; },
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => { localCloseCalled = true; },
  };

  await withServer({ mockDb, mockSf, mockClose, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      ticket_id: 7,
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(res.status, 400);
    assert.equal(sfCloseCalled, false);
    assert.equal(localCloseCalled, false);
    assert.match(res.body.error, /no coincide/);
  });
});

test('Salesforce ticket-aware close validates required fields before local close', async () => {
  let authChecked = false;
  let closeCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => { authChecked = true; return { id: 7 }; },
    getAnalystByTokenId: async () => ({ id: 10 }),
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => { closeCalled = true; },
  };

  await withServer({ mockDb, mockClose, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', { ticket_id: 7, resolucion: 'ok' });
    assert.equal(res.status, 400);
    assert.equal(authChecked, false);
    assert.equal(closeCalled, false);
  });
});

test('Salesforce ticket-aware close returns pending outbox status for authorized analyst without direct Salesforce close', async () => {
  let closeArgs;
  let sfCloseCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: { analyst_id: 10 }, sf_case_id: '500xx' }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 2 }),
  };
  const mockSf = {
    cerrarCase: async () => { sfCloseCalled = true; },
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async args => {
      closeArgs = args;
      return {
        ticketId: args.ticketId,
        ticket: { id: args.ticketId, status: 'closed' },
        salesforceStatus: 'pending',
        salesforceCloseStatus: 'pending',
        salesforceOutboxStatus: 'pending',
        salesforceOutboxJob: { id: 99, ticket_id: args.ticketId, operation: 'case_close', status: 'pending' },
      };
    },
  };

  await withServer({ mockDb, mockSf, mockClose, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      ticket_id: 7,
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(res.status, 200);
    assert.equal(closeArgs.ticketId, 7);
    assert.equal(closeArgs.closeSalesforce, true);
    assert.equal(sfCloseCalled, false);
    assert.equal(res.body.salesforceStatus, 'pending');
    assert.equal(res.body.salesforceCloseStatus, 'pending');
    assert.equal(res.body.salesforceOutboxStatus, 'pending');
    assert.equal(res.body.salesforceOutboxJob.status, 'pending');
  });
});

test('Salesforce ticket-aware close returns non-2xx when Salesforce outbox enqueue fails', async () => {
  let closeCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: null, sf_case_id: '500xx' }),
    getAnalystByTokenId: async () => null,
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => {
      closeCalled = true;
      const err = new Error('Salesforce outbox schema is not available.');
      err.statusCode = 503;
      err.code = 'SF_OUTBOX_SCHEMA_MISSING';
      throw err;
    },
  };

  await withServer({ mockDb, mockClose, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      ticket_id: 7,
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(closeCalled, true);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'SF_OUTBOX_SCHEMA_MISSING');
  });
});

test('Salesforce ticket-aware close returns controlled code for generic outbox enqueue failure', async () => {
  let closeCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: null, sf_case_id: '500xx' }),
    getAnalystByTokenId: async () => null,
  };
  const mockClose = {
    validateSalesforceCloseFields,
    closeTicket: async () => {
      closeCalled = true;
      const err = new Error('No se pudo encolar el cierre de Salesforce. El ticket local no fue cerrado.');
      err.statusCode = 502;
      err.code = 'SF_OUTBOX_ENQUEUE_FAILED';
      throw err;
    },
  };

  await withServer({ mockDb, mockClose, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases/500xx/close', {
      ticket_id: 7,
      resolucion: 'ok',
      subetapa_resuelto: 'Solucionado',
    });
    assert.equal(closeCalled, true);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'SF_OUTBOX_ENQUEUE_FAILED');
    assert.doesNotMatch(res.body.error, /duplicate key|23505|Supabase/i);
  });
});

test('Salesforce case read requires ticket_id before Salesforce call', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => { throw new Error('should not load ticket without ticket_id'); },
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    obtenerCase: async () => { sfCalled = true; return {}; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/cases/500xx');
    assert.equal(res.status, 400);
    assert.equal(sfCalled, false);
    assert.match(res.body.error, /ticket_id/);
  });
});

test('Salesforce ticket outbox status enforces ticket-scoped authorization', async () => {
  let listed = false;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: null }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 3 }),
    listTicketSalesforceOutboxJobs: async () => { listed = true; return []; },
  };

  await withServer({ mockDb, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/tickets/7/outbox');
    assert.equal(res.status, 403);
    assert.equal(listed, false);
  });
});

test('Salesforce ticket outbox status returns jobs for authorized ticket without Salesforce call', async () => {
  let listArgs;
  let sfCalled = false;
  const jobs = [{ id: 1, ticket_id: 7, status: 'pending', operation: 'case_close', payload: { transcript: 'secret' }, idempotency_key: 'secret-key', last_error: 'raw error' }];
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: { analyst_id: 10 } }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 2 }),
    listTicketSalesforceOutboxJobs: async (ticketId, filters) => { listArgs = { ticketId, filters }; return jobs; },
  };
  const mockSf = { obtenerCase: async () => { sfCalled = true; } };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/tickets/7/outbox?status=pending&limit=5&offset=1');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      jobs: [{
        id: 1,
        ticket_id: 7,
        sf_case_id: null,
        operation: 'case_close',
        status: 'pending',
        attempts: null,
        next_attempt_at: null,
        processed_at: null,
        created_at: null,
        updated_at: null,
      }],
    });
    assert.equal(listArgs.ticketId, '7');
    assert.equal(listArgs.filters.status, 'pending');
    assert.equal(listArgs.filters.limit, 5);
    assert.equal(listArgs.filters.offset, 1);
    assert.equal(sfCalled, false);
  });
});

test('Salesforce ticket outbox status maps missing schema to controlled 503', async () => {
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: { analyst_id: 10 } }),
    getAnalystByTokenId: async () => null,
    listTicketSalesforceOutboxJobs: async () => {
      const err = new Error('Salesforce outbox schema is not available.');
      err.statusCode = 503;
      err.code = 'SF_OUTBOX_SCHEMA_MISSING';
      throw err;
    },
  };

  await withServer({ mockDb, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/tickets/7/outbox');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'SF_OUTBOX_SCHEMA_MISSING');
  });
});

test('Salesforce case create requires ticket_id before Salesforce call', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => { throw new Error('should not load ticket without ticket_id'); },
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    crearCase: async () => { sfCalled = true; return {}; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases', { Subject: 'New case' });
    assert.equal(res.status, 400);
    assert.equal(sfCalled, false);
    assert.match(res.body.error, /ticket_id/);
  });
});

test('Salesforce route redacts upstream error text before returning or logging it', async (t) => {
  const originalError = console.error;
  const errorLogs = [];
  const rawMessage = 'Salesforce failed for person@example.com token=raw-token phone +57 300 123 4567';
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  t.after(() => { console.error = originalError; });

  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: { analyst_id: 10 } }),
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    crearCase: async () => { throw new Error(rawMessage); },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases', { ticket_id: 7, Subject: 'New case' });
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.body.error, /person@example\.com/);
    assert.doesNotMatch(res.body.error, /raw-token/);
    assert.doesNotMatch(res.body.error, /300 123 4567/);
    assert.match(res.body.error, /\[REDACTED\]/);
  });

  const logText = errorLogs.join('\n');
  assert.doesNotMatch(logText, /person@example\.com/);
  assert.doesNotMatch(logText, /raw-token/);
  assert.doesNotMatch(logText, /300 123 4567/);
  assert.match(logText, /\[REDACTED\]/);
});

test('Salesforce case create rejects unauthorized analyst before Salesforce call', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: null }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 3 }),
  };
  const mockSf = {
    crearCase: async () => { sfCalled = true; return {}; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases', { ticket_id: 7, Subject: 'New case' });
    assert.equal(res.status, 403);
    assert.equal(sfCalled, false);
  });
});

test('Salesforce case create allows authorized admin, strips local fields, and binds result to ticket', async () => {
  let createPayload;
  let updatedTicket;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: null }),
    getAnalystByTokenId: async () => null,
    updateTicketSalesforce: async (id, sfData) => { updatedTicket = { id, sfData }; },
  };
  const mockSf = {
    crearCase: async body => {
      createPayload = body;
      return { id: '500xx', CaseNumber: '00001042' };
    },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases', {
      ticket_id: 7,
      ticketId: 999,
      user: { role: 'admin' },
      actor: 'spoof',
      auth: 'spoof',
      authorization: 'Bearer spoof',
      Subject: 'New case',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(createPayload, { Subject: 'New case' });
    assert.deepEqual(updatedTicket, { id: 7, sfData: { sf_case_id: '500xx', sf_case_number: '00001042' } });
    assert.deepEqual(res.body, { id: '500xx', CaseNumber: '00001042' });
  });
});

test('Salesforce case create returns non-2xx when local binding fails after Salesforce create', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: null }),
    getAnalystByTokenId: async () => null,
    updateTicketSalesforce: async () => { throw new Error('database-url=secret'); },
  };
  const mockSf = {
    crearCase: async () => {
      sfCalled = true;
      return { id: '500xx', CaseNumber: '00001042' };
    },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await postJson(baseUrl, '/api/sf/cases', { ticket_id: 7, Subject: 'New case' });
    assert.equal(sfCalled, true);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'SF_CASE_BIND_FAILED');
    assert.match(res.body.error, /local ticket binding failed/);
    assert.doesNotMatch(res.body.error, /secret/);
  });
});

test('Salesforce account lookup requires ticket_id before Salesforce call', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => { throw new Error('should not load ticket without ticket_id'); },
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    buscarCuentas: async () => { sfCalled = true; return []; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/accounts?q=Acme');
    assert.equal(res.status, 400);
    assert.equal(sfCalled, false);
    assert.match(res.body.error, /ticket_id/);
  });
});

test('Salesforce account lookup rejects unauthorized ticket_id before Salesforce call', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: null }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 3 }),
  };
  const mockSf = {
    buscarCuentas: async () => { sfCalled = true; return []; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/accounts?q=Acme&ticket_id=7');
    assert.equal(res.status, 403);
    assert.equal(sfCalled, false);
  });
});

test('Salesforce account lookup allows authorized ticket_id', async () => {
  let searchTerm;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: { analyst_id: 10 } }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 2 }),
  };
  const mockSf = {
    buscarCuentas: async q => { searchTerm = q; return [{ id: '001xx', name: 'Acme' }]; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/accounts?q=Acme&ticket_id=7');
    assert.equal(res.status, 200);
    assert.equal(searchTerm, 'Acme');
    assert.deepEqual(res.body, [{ id: '001xx', name: 'Acme' }]);
  });
});

test('Salesforce case update rejects unauthorized analyst before Salesforce call', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: null, sf_case_id: '500xx' }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 3 }),
  };
  const mockSf = {
    actualizarCase: async () => { sfCalled = true; return {}; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'PATCH', '/api/sf/cases/500xx', { ticket_id: 7, subject: 'Updated' });
    assert.equal(res.status, 403);
    assert.equal(sfCalled, false);
  });
});

test('Salesforce case assign rejects Case ID mismatch before Salesforce call', async () => {
  let sfCalled = false;
  const mockDb = {
    getTicketWithAssignment: async () => ({ id: 7, area_id: 2, assignment: null, sf_case_id: '500yy' }),
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    asignarmeCase: async () => { sfCalled = true; return {}; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'PATCH', '/api/sf/cases/500xx/assign-me', { ticket_id: 7 });
    assert.equal(res.status, 400);
    assert.equal(sfCalled, false);
    assert.match(res.body.error, /no coincide/);
  });
});

test('Salesforce case read allows authorized admin with matching ticket', async () => {
  let sfCaseId;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: { analyst_id: 10 }, sf_case_id: '500xx' }),
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    obtenerCase: async id => { sfCaseId = id; return { Id: id }; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'GET', '/api/sf/cases/500xx?ticket_id=7');
    assert.equal(res.status, 200);
    assert.equal(sfCaseId, '500xx');
    assert.deepEqual(res.body, { Id: '500xx' });
  });
});

test('Salesforce case update allows authorized admin and strips ticket_id from Salesforce payload', async () => {
  let updateArgs;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: { analyst_id: 10 }, sf_case_id: '500xx' }),
    getAnalystByTokenId: async () => null,
  };
  const mockSf = {
    actualizarCase: async (id, body) => { updateArgs = { id, body }; return { Id: id, ...body }; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'admin', name: 'Admin' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'PATCH', '/api/sf/cases/500xx', { ticket_id: 7, Subject: 'Updated' });
    assert.equal(res.status, 200);
    assert.deepEqual(updateArgs, { id: '500xx', body: { Subject: 'Updated' } });
    assert.deepEqual(res.body, { Id: '500xx', Subject: 'Updated' });
  });
});

test('Salesforce case assign allows authorized analyst with matching ticket', async () => {
  let sfCaseId;
  const mockDb = {
    getTicketWithAssignment: async id => ({ id, area_id: 2, assignment: { analyst_id: 10 }, sf_case_id: '500xx' }),
    getAnalystByTokenId: async () => ({ id: 10, area_id: 2 }),
  };
  const mockSf = {
    asignarmeCase: async id => { sfCaseId = id; return { Id: id, OwnerId: 'me' }; },
  };

  await withServer({ mockDb, mockSf, mockClose: { validateSalesforceCloseFields, closeTicket: async () => null }, user: { id: 1, role: 'analyst', name: 'Analyst' } }, async baseUrl => {
    const res = await requestJson(baseUrl, 'PATCH', '/api/sf/cases/500xx/assign-me', { ticket_id: 7 });
    assert.equal(res.status, 200);
    assert.equal(sfCaseId, '500xx');
    assert.deepEqual(res.body, { Id: '500xx', OwnerId: 'me' });
  });
});
