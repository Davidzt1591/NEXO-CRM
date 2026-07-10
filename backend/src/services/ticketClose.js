const DEFAULT_FAREWELL =
  'Estimado usuario, su solicitud ha sido *atendida y el ticket cerrado exitosamente*. ✅\n\n' +
  'Ha sido un gusto poder ayudarle. Si en algún momento tiene un nuevo requerimiento, ' +
  'no dude en contactarnos nuevamente.\n\n' +
  '¡Hasta pronto! 👋 — *Equipo de Integraciones Magneto365*';

const MAX_CASE_COMMENT_BYTES = 4000;

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function chunkUtf8(text, maxBytes = MAX_CASE_COMMENT_BYTES) {
  const chunks = [];
  let current = '';

  for (const char of String(text || '')) {
    const next = current + char;
    if (byteLength(next) > maxBytes) {
      if (current) chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function actorLabel(message) {
  if (message.is_bot) return 'Bot';
  return message.from_user ? 'Cliente' : 'Agente';
}

function compileTranscript(ticket, messages = []) {
  const lines = [
    `Transcripción NEXO — Ticket ${ticket?.id || ''}`.trim(),
    ticket?.sf_case_number ? `Caso Salesforce: ${ticket.sf_case_number}` : null,
    ticket?.telefono ? `Teléfono: ${ticket.telefono}` : null,
    ticket?.nombre_analista ? `Nombre: ${ticket.nombre_analista}` : null,
    ticket?.created_at ? `Creado: ${ticket.created_at}` : null,
    '',
    ...messages.map(message => {
      const timestamp = message.timestamp || message.created_at || '';
      return `[${timestamp}] ${actorLabel(message)}: ${message.body || ''}`;
    }),
  ].filter(line => line !== null && line !== undefined);

  return lines.join('\n');
}

function chunkTranscriptForCaseComments(transcript, maxBytes = MAX_CASE_COMMENT_BYTES) {
  const prefix = 'Transcripción NEXO';
  const bodyBudget = maxBytes - byteLength(`${prefix} (parte 999/999)\n`);
  const chunks = chunkUtf8(transcript, bodyBudget);
  return chunks.map((chunk, index) => `${prefix} (parte ${index + 1}/${chunks.length})\n${chunk}`);
}

function validateSalesforceCloseFields({ resolucion, subetapa_resuelto }) {
  if (!resolucion || !String(resolucion).trim()) {
    const err = new Error('La resolución es obligatoria para cerrar el caso.');
    err.statusCode = 400;
    err.code = 'SF_CLOSE_VALIDATION';
    throw err;
  }
  if (!subetapa_resuelto || !String(subetapa_resuelto).trim()) {
    const err = new Error('Debes seleccionar una subetapa de resolución.');
    err.statusCode = 400;
    err.code = 'SF_CLOSE_VALIDATION';
    throw err;
  }
}

async function closeTicket({
  ticketId,
  actor = null,
  resolucion = null,
  subetapa_resuelto = null,
  sendFarewell = false,
  whatsappClient = null,
  closeSalesforce = false,
  db = require('../database/db'),
  sf = require('./salesforce'),
} = {}) {
  const ticket = await db.getTicketById(ticketId);
  if (!ticket) {
    const err = new Error('Ticket not found.');
    err.statusCode = 404;
    throw err;
  }

  if (closeSalesforce) {
    validateSalesforceCloseFields({ resolucion, subetapa_resuelto });
  }

  let messages = [];
  let transcriptCommentCount = 0;
  let salesforceStatus = ticket.sf_case_id ? 'pending' : 'skipped';
  let salesforceCloseStatus = closeSalesforce && ticket.sf_case_id ? 'pending' : 'skipped';
  let transcriptStatus = ticket.sf_case_id ? 'pending' : 'skipped';
  let salesforceError = null;
  let transcriptError = null;

  if (ticket.sf_case_id) {
    try {
      messages = await db.getTranscriptMessages(ticketId);
      const transcript = compileTranscript(ticket, messages);
      const comments = chunkTranscriptForCaseComments(transcript);
      for (const comment of comments) {
        await sf.createCaseComment(ticket.sf_case_id, comment);
        transcriptCommentCount += 1;
      }
      transcriptStatus = 'success';
    } catch (err) {
      transcriptStatus = 'failed';
      transcriptError = err.message;
    }

    if (closeSalesforce) {
      try {
        await sf.cerrarCase(ticket.sf_case_id, resolucion, subetapa_resuelto);
        salesforceCloseStatus = 'success';
      } catch (err) {
        salesforceCloseStatus = 'failed';
        salesforceStatus = 'failed';
        salesforceError = err.message;
        await safeAudit(db, actor, 'ticket.close_sf_failed', ticketId, {
          sf_case_id: ticket.sf_case_id,
          salesforce_status: salesforceStatus,
          salesforce_close_status: salesforceCloseStatus,
          transcript_status: transcriptStatus,
          transcript_comment_count: transcriptCommentCount,
          message_count: messages.length,
          transcript_error: transcriptError || undefined,
          error: salesforceError,
        });
        err.statusCode = err.statusCode || 502;
        err.code = err.code || 'SF_CLOSE_FAILED';
        throw err;
      }
    }

    salesforceStatus = closeSalesforce
      ? salesforceCloseStatus
      : (transcriptStatus === 'failed' ? 'failed' : 'success');
    salesforceError = closeSalesforce ? null : transcriptError;
  }

  const closedTicket = await db.closeTicket(ticketId);

  let farewellSent = false;
  if (sendFarewell && whatsappClient && ticket.telefono) {
    try {
      await whatsappClient.sendMessage(ticket.telefono, DEFAULT_FAREWELL);
      await db.saveMessage({ ticket_id: ticketId, chat_id: ticket.telefono, body: DEFAULT_FAREWELL, from_user: false, is_bot: true });
      farewellSent = true;
    } catch (err) {
      await safeAudit(db, actor, 'ticket.close_farewell_failed', ticketId, { error: err.message });
    }
  }

  await safeAudit(db, actor, salesforceStatus === 'failed' ? 'ticket.close_sf_failed' : 'ticket.closed', ticketId, {
    sf_case_id: ticket.sf_case_id || null,
    salesforce_status: salesforceStatus,
    salesforce_close_status: salesforceCloseStatus,
    transcript_status: transcriptStatus,
    transcript_comment_count: transcriptCommentCount,
    message_count: messages.length,
    farewell_sent: farewellSent,
    transcript_error: transcriptError || undefined,
    error: salesforceError || undefined,
  });

  return {
    ticketId,
    ticket: closedTicket || ticket,
    salesforceStatus,
    salesforceCloseStatus,
    salesforceError,
    transcriptStatus,
    transcriptError,
    transcriptCommentCount,
    farewellSent,
  };
}

async function safeAudit(db, actor, action, targetId, metadata) {
  if (!db.logAudit) return null;
  try {
    return await db.logAudit({
      actor_name: actor?.name || 'system',
      actor_role: actor?.role || 'system',
      action,
      target_id: String(targetId),
      metadata,
    });
  } catch (err) {
    console.warn('⚠️  No se pudo escribir auditoría de cierre:', err.message);
    return null;
  }
}

module.exports = {
  DEFAULT_FAREWELL,
  MAX_CASE_COMMENT_BYTES,
  compileTranscript,
  chunkTranscriptForCaseComments,
  validateSalesforceCloseFields,
  closeTicket,
};
