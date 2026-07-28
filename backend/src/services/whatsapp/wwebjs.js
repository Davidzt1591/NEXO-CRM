const { assertLocalAuthOnly } = require('./authPolicy');
assertLocalAuthOnly();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs     = require('fs');
const path   = require('path');
const store  = require('../../store');
const db     = require('../../database/db');
const { analizarPrioridad } = require('../ai');
const { crearCase }         = require('../salesforce');
const botFlow               = require('../botFlow');
const operationalRealtime = require('../../realtime/operational');
const emitAdminFallback = (io, event, payload) => {
  if (typeof io.to === 'function') return io.to('admin').emit(event, payload);
  if (typeof io.emit === 'function') return io.emit(event, payload);
  return undefined;
};
const emitClassified = operationalRealtime.emitClassified || ((io, emission) => emitAdminFallback(io, emission.event, emission.adminPayload));
const emitTicketOperation = operationalRealtime.emitTicketOperation || ((io, event, payload) => emitAdminFallback(io, event, payload));
const routing               = require('../routing');
const { decideFlowTransition } = require('../botFlowTransitions');
const { escapeWhatsApp } = require('../botFlowMessages');
const { validateWhatsAppMedia } = require('../mediaValidation');
const { uploadWhatsAppMediaForTicket } = require('../salesforceMedia');
const crypto = require('crypto');
const { sendCandidateGuidanceIfAllowed } = require('../candidateSupport');
const { candidateQuarantine: defaultCandidateQuarantine } = require('../candidateQuarantine');
const ticketPostProcessing = require('../ticketPostProcessing');
const { normalizeCauseCode } = require('../../startup');
const {
  classificationRetryConfig,
  classificationState,
  lookupCandidateClassification,
} = require('../classificationReliability');

// ── Helpers ────────────────────────────────────────────────────────────────

async function borrarSesion(client) {
  const posibles = [
    path.resolve('.wwebjs_auth', 'session'),
    path.resolve('.wwebjs_auth', 'session-nexo'),
    path.resolve('.wwebjs_auth'),
  ];
  for (const dir of posibles) {
    try {
      if (fs.existsSync(dir)) {
        // Wait a bit to let Chromium release file locks
        await new Promise(r => setTimeout(r, 2000));
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('🗑️  Sesión eliminada:', dir);
        break;
      }
    } catch (e) {
      console.warn('⚠️  No se pudo borrar sesión:', dir, e.message);
    }
  }
}

function estaEnHorarioLaboral() {
  const ahora = new Date();
  const dia   = ahora.getDay();
  const t     = ahora.getHours() + ahora.getMinutes() / 60;
  if (dia >= 1 && dia <= 4) return t >= 7 && t < 17;
  if (dia === 5)             return t >= 7 && t < 16;
  return false;
}

async function resolveTicketArea(ticketId) {
  if (!ticketId) return null;
  const ticket = await db.getTicketById(ticketId);
  return ticket?.area_id || null;
}

async function emitPrivateTicketEvent(io, event, payload, ticketId) {
  const ticket = ticketId && typeof db.getTicketWithRouting === 'function' ? await db.getTicketWithRouting(ticketId) : null;
  emitClassified(io, {
    event,
    adminPayload: payload,
    analystId: ticket?.assignment?.analyst_id || null,
    analystPayload: ticket?.assignment?.analyst_id ? payload : null,
  });
}

async function auditPendingEffect(action, ticketId, error) {
  try {
    await db.logAudit?.({
      actor_name: 'whatsapp-bot', actor_role: 'system', action,
      target_id: String(ticketId), metadata: { code: String(error?.code || 'POST_INSERT_FAILED').slice(0, 120) },
    });
  } catch (auditErr) {
    console.warn('⚠️ Could not persist post-insert failure audit:', auditErr.message);
  }
}

// ── Session sync: memory ↔ Supabase ──────────────────────────────────────────

async function syncSessionToDb(chatId) {
  const s = store.sesiones[chatId];
  if (s) {
    await db.saveSession(chatId, s);
  } else {
    await db.deleteSession(chatId);
  }
}

async function loadSessionsFromDb() {
  const rows = await db.loadAllSessions();
  for (const row of rows) {
      store.sesiones[row.chat_id] = {
        paso:      row.paso,
        categoria: row.categoria || undefined,
        nombre:    row.nombre    || undefined,
        empresa:   row.empresa   || undefined,
        correo:    row.correo    || undefined,
        situacion: row.situacion || undefined,
        ticketId:  row.ticket_id || undefined,
        submissionId: row.submission_id || undefined,
        flowVersionId: row.flow_version_id || undefined,
      };
  }
  return rows.length;
}

async function respuestaBot(io, message, texto, ticketId = null, chatId = null) {
  const sent      = await message.reply(texto);
  const timestamp = new Date().toISOString();
  const cid       = chatId || message.from;
  let   savedId   = null;

  if (ticketId) {
    const saved = await db.saveMessage({
      ticket_id:    ticketId,
      chat_id:      cid,
      body:         texto,
      from_user:    false,
      is_bot:       true,
      wa_message_id: sent?.id?._serialized || null,
    });
    savedId = saved?.id;
  }

  await emitPrivateTicketEvent(io, 'new-message', {
    chatId:      cid,
    ticketId,
    message:     texto,
    waMessageId: sent?.id?._serialized || null,
    from_user:   false,
    is_bot:      true,
    timestamp,
    id:          savedId,
  }, ticketId);
}

async function respuestaFlujo(io, message, stepKey, values = {}, ticketId = null, chatId = null, areaId = null) {
  const resolved = await botFlow.getBotMessage(stepKey, values, { areaId });
  const cid = chatId || message.from;
  const shouldPersistVersion = store.sesiones[cid] && resolved.versionId && store.sesiones[cid].flowVersionId !== resolved.versionId;
  if (shouldPersistVersion) {
    store.sesiones[cid].flowVersionId = resolved.versionId;
    await syncSessionToDb(cid);
  }
  await respuestaBot(io, message, resolved.text, ticketId, cid);
  return resolved;
}

function createWhatsAppMessageHandler(io, client, options = {}) {
  const isBusinessHours = options.isBusinessHours || estaEnHorarioLaboral;
  const candidateQuarantine = options.candidateQuarantine || defaultCandidateQuarantine;
  const classificationReliabilityState = options.classificationState || classificationState;
  const classificationConfig = options.classificationRetryConfig || classificationRetryConfig();
  const candidateLogger = options.logger || console;
  const logCandidateBoundaryFailure = (event, error, outcome = 'blocked') => {
    candidateLogger.warn(event, { causeCode: normalizeCauseCode(error), attempt: 1, outcome });
  };

  return async function handleWhatsAppMessage(message) {
    if (message.fromMe)                           return;
    if (!message.from)                            return;
    if (message.from.includes('@g.us'))           return;
    if (message.from === 'status@broadcast')      return;
    if (message.from.includes('@newsletter'))     return;
    if (message.from.includes('@broadcast'))      return;
    if (message.type === 'e2e_notification')      return;
    if (message.type === 'notification_template') return;
    if (message.type === 'call_log')              return;
    if (!message.timestamp || message.timestamp <= store.horaDeInicio) return;

    const chatId = message.from;
    const texto  = message.body?.trim() || '';

    // Classification is an authorization boundary and must run before any
    // session, ticket, media or operational processing. Database uncertainty
    // fails closed so a known candidate cannot slip into analyst support.
    let locallyQuarantined = false;
    try {
      locallyQuarantined = await candidateQuarantine.has(chatId);
    } catch (err) {
      logCandidateBoundaryFailure('candidate_quarantine_lookup_failed', err);
      return;
    }
    const classificationResult = await lookupCandidateClassification({
      lookup: () => db.getCandidateClassification(chatId),
      state: classificationReliabilityState,
      config: classificationConfig,
      sleep: options.classificationSleep,
      random: options.classificationRandom,
      now: options.now,
      logger: options.logger,
      captureException: options.captureException,
    });
    if (!classificationResult.ok) return;
    const classification = classificationResult.classification;
    if (locallyQuarantined || (classification?.classification === 'candidate' && classification.support_blocked !== false)) {
      if (locallyQuarantined && !classification) {
        try {
          await db.markCandidate(chatId, { source: 'auto', markedBy: 'whatsapp-bot' });
        } catch (err) {
          logCandidateBoundaryFailure('candidate_classification_persist_failed', err, 'pending');
          return;
        }
      }
      delete store.sesiones[chatId];
      await db.deleteSession(chatId);
      await sendCandidateGuidanceIfAllowed({ db, message, chatId });
      return;
    }

    const pendingSession = store.sesiones[chatId]?.paso === 'candidate_pending';
    if (pendingSession) {
      try {
        await candidateQuarantine.add(chatId);
        await db.markCandidate(chatId, { source: 'auto', markedBy: 'whatsapp-bot' });
      } catch (err) {
        logCandidateBoundaryFailure('candidate_classification_persist_failed', err, 'pending');
        return;
      }
      delete store.sesiones[chatId];
      await db.deleteSession(chatId);
      await sendCandidateGuidanceIfAllowed({ db, message, chatId });
      return;
    }

    // Candidate audience selection is evaluated before contact lookup, message
    // persistence, media handling, or any operational broadcast containing PII.
    const initialSession = store.sesiones[chatId];
    const audienceTransition = initialSession?.paso === 'audience_choice'
      ? decideFlowTransition(initialSession, texto)
      : null;
    if (audienceTransition?.type === 'end' && audienceTransition.reason === 'candidate_exit') {
      initialSession.paso = 'candidate_pending';
      let quarantineError = null;
      try {
        await candidateQuarantine.add(chatId);
      } catch (err) {
        quarantineError = err;
        logCandidateBoundaryFailure('candidate_quarantine_persist_failed', err, 'fail_closed');
      }
      try {
        await db.markCandidate(chatId, { source: 'auto', markedBy: 'whatsapp-bot' });
      } catch (err) {
        logCandidateBoundaryFailure('candidate_classification_persist_failed', err, 'fail_closed');
        try {
          await syncSessionToDb(chatId);
        } catch (sessionErr) {
          logCandidateBoundaryFailure('candidate_pending_session_persist_failed', sessionErr, 'fail_closed');
        }
        if (quarantineError) candidateLogger.warn('candidate_marking_unavailable', { causeCode: 'UNKNOWN_ERROR', attempt: 1, outcome: 'fail_closed' });
        return;
      }
      delete store.sesiones[chatId];
      await db.deleteSession(chatId);
      await sendCandidateGuidanceIfAllowed({ db, message, chatId });
      return;
    }

    let realPhone = null;
    try {
      const contact = await client.getContactById(chatId);
      if (contact?.number) realPhone = contact.number;
    } catch (_) { /* fallback to chatId */ }

    let mediaPayload = null;
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          const candidate = {
            data:     media.data,
            mimetype: media.mimetype,
            filename: media.filename || '',
          };
          const validated = validateWhatsAppMedia(candidate);
          mediaPayload = { ...candidate, metadata: { filename: validated.filename, mimetype: validated.mimetype, sizeBytes: validated.sizeBytes } };
        }
      } catch (e) {
        console.warn('⚠️  Media download/validation error:', e.message);
      }
    }

    const displayBody = texto || (mediaPayload
      ? `[${mediaPayload.mimetype?.split('/')[0] || 'media'}]`
      : '');

    const sesion = store.sesiones[chatId];

    let savedId = null;
    if (sesion?.ticketId) {
      const saved = await db.saveMessage({
        ticket_id:    sesion.ticketId,
        chat_id:      chatId,
        body:         displayBody,
        from_user:    true,
        is_bot:       false,
        wa_message_id: message.id._serialized,
      });
      savedId = saved?.id;
    }

    let mediaUpload = null;
    if (mediaPayload?.data && sesion?.ticketId) {
      try {
        mediaUpload = await uploadWhatsAppMediaForTicket({ ticketId: sesion.ticketId, media: mediaPayload });
      } catch (err) {
        console.warn('⚠️  No se pudo subir adjunto WhatsApp a Salesforce:', err.message);
        mediaUpload = { uploaded: false, reason: 'upload_failed', metadata: mediaPayload.metadata };
      }
    }

    await emitPrivateTicketEvent(io, 'new-message', {
      chatId,
      ticketId:    sesion?.ticketId || null,
      message:     displayBody,
      media:       mediaPayload?.metadata || null,
      mediaUpload,
      waMessageId: message.id._serialized,
      from_user:   true,
      is_bot:      false,
      timestamp:   new Date().toISOString(),
      id:          savedId,
    }, sesion?.ticketId || null);

    if (!store.botActivo)                            return;
    if (store.silenciados.has(chatId))               return;
    if (store.chatModes.get(chatId) === 'manual')    return;
    if (message.hasMedia && !texto)                  return;

    if (!isBusinessHours()) {
      await respuestaFlujo(io, message, 'out_of_office', {}, sesion?.ticketId || null);
      return;
    }

    if (!store.sesiones[chatId]) {
      store.sesiones[chatId] = { paso: 'audience_choice', submissionId: crypto.randomUUID() };
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, 'welcome_audience');
      return;
    }

    const s = store.sesiones[chatId];
    const transition = decideFlowTransition(s, texto);

    if (transition.type === 'complete') {
      delete store.sesiones[chatId];
      await syncSessionToDb(chatId);
      return;
    }

    if (transition.type === 'advance' || transition.type === 'retry') {
      if (transition.type === 'advance') s.paso = transition.nextPaso;
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, transition.messageKey, s.nombre ? { nombre: escapeWhatsApp(s.nombre) } : {});
      return;
    }

    if (transition.type === 'migrate') {
      for (const field of ['categoria', 'nombre', 'empresa', 'correo', 'situacion', 'ticketId']) delete s[field];
      s.submissionId = crypto.randomUUID();
      s.paso = transition.nextPaso;
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, transition.messageKey);
      return;
    }

    if (transition.type === 'end') {
      delete store.sesiones[chatId];
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, transition.messageKey);
      return;
    }

    if (transition.type === 'category') {
      s.categoria = transition.value;
      s.categoryKey = transition.categoryKey;
      s.paso = transition.nextPaso;
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, transition.messageKey, { categoria: escapeWhatsApp(s.categoria) });
      return;
    }

    if (transition.type === 'capture') {
      s[transition.field] = transition.value;
      s.paso = transition.nextPaso;
      await syncSessionToDb(chatId);
      const values = transition.messageKey === 'confirm_summary'
        ? Object.fromEntries(['categoria', 'nombre', 'empresa', 'correo', 'situacion'].map(key => [key, escapeWhatsApp(s[key])]))
        : { nombre: escapeWhatsApp(s.nombre) };
      await respuestaFlujo(io, message, transition.messageKey, values);
      return;
    }

    if (transition.type === 'correct') {
      for (const field of ['nombre', 'empresa', 'correo', 'situacion']) delete s[field];
      s.paso = transition.nextPaso;
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, transition.messageKey);
      return;

    } else if (transition.type === 'ticket') {
      if (transition.field) s[transition.field] = transition.value;
      if (!s.submissionId) {
        s.submissionId = crypto.randomUUID();
        await syncSessionToDb(chatId);
      }
      await respuestaFlujo(io, message, 'processing');

      try {
        const phone     = realPhone || chatId.replace(/@c\.us|@lid/g, '');

        if (typeof db.createRoutedTicket !== 'function') {
          console.error('PHASE10_ROUTING_UNAVAILABLE', { submissionId: s.submissionId, categoryKey: s.categoryKey || null });
          throw Object.assign(new Error('Category routing is unavailable.'), { code: 'CATEGORY_ROUTING_UNAVAILABLE' });
        }
        const categoryKey = s.categoryKey || ({ Platform: 'platform', Tests: 'tests', Requests: 'requests', Integrations: 'integrations' })[s.categoria];
        const ticket = await db.createRoutedTicket({
          chat_id:        chatId,
          telefono:       phone,
          nombre_analista: s.nombre,
          nombre_empresa:  s.empresa,
           correo:          s.correo,
           situacion:       s.situacion,
           categoria:       s.categoria || null,
          category_key:     categoryKey,
          prioridad: null,
          submission_id: s.submissionId,
        });

        s.ticketId = ticket.id;
        await db.ensureTicketPostProcessing(ticket.id);

        let sfCaseNumber = null;
        let sfCaseId     = null;
        let routedTicket = null;
        const pending = [];
        if (ticket.created) {
          try {
            const prioridad = await analizarPrioridad(s.situacion);
            const prioritizedTicket = await db.updateTicketPriority(ticket.id, prioridad);
            routedTicket = await db.getTicketWithRouting(ticket.id);
            if (routedTicket?.assignment?.analyst_id) emitTicketOperation(io, 'ticket-assigned', routedTicket, { areaPayload: routing.enrichTicket(routedTicket) && require('../../realtime/operational').toMinimalQueueCard(routing.enrichTicket(routedTicket)) });
          } catch (routingErr) {
            pending.push('assignment');
            console.warn('⚠️ Post-insert routing pending:', routingErr.message);
            await auditPendingEffect('ticket_routing_pending', ticket.id, routingErr);
          }
        }

        const recovered = await ticketPostProcessing.processBatch({ db, io, limit: 1 }).catch(async error => {
          pending.push('post-processing');
          await auditPendingEffect('ticket_post_processing_pending', ticket.id, error);
          return null;
        });
        if (recovered?.results?.some(result => result.effects.some(effect => ['failed', 'uncertain', 'attempt_start_failed', 'lease_lost'].includes(effect.status)))) pending.push('post-processing');

        const radicado = sfCaseNumber
          ? `Número de caso Salesforce: *#${sfCaseNumber}*`
          : `Número de caso interno: *${String(ticket.id)}*`;

        const pendingNote = pending.length ? '\n\nLa asignación o integración está pendiente; tu caso ya quedó registrado.' : '';
        const ackClaimToken = crypto.randomUUID();
        const ackClaimed = await db.claimTicketWhatsAppAck(ticket.id, ackClaimToken).catch(() => false);
        if (ackClaimed) {
          try {
            await respuestaFlujo(io, message, 'confirmation', { radicado: `${radicado}${pendingNote}`, ticketId: ticket.id, sfCaseNumber, sfCaseId }, ticket.id);
            await db.finalizeTicketWhatsAppAck(ticket.id, ackClaimToken);
          } catch (ackError) {
            console.warn('⚠️ WhatsApp acknowledgement status is uncertain; it will not be retried automatically:', ackError.message);
          }
        }
        delete store.sesiones[chatId];

      } catch (err) {
        console.error('❌ Error creando ticket:', err.message);
        if (s.ticketId) {
          await auditPendingEffect('ticket_post_processing_pending', s.ticketId, err);
          console.warn(`⚠️ Ticket #${s.ticketId} is durable; post-processing remains recoverable.`);
        } else {
          await respuestaFlujo(io, message, 'ticket_error');
        }
        delete store.sesiones[chatId];
        if (!s.ticketId) await syncSessionToDb(chatId);
      }
    }
  };
}

// ── Main setup ─────────────────────────────────────────────────────────────

function createWhatsAppClient(options = {}) {
  const dataPath = options.dataPath || '.wwebjs_auth';
  return new Client({
    authStrategy: new LocalAuth({ dataPath }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-notifications',
      ],
      headless: true,
    },
  });
}

function setupWhatsApp(io, options = {}) {
  assertLocalAuthOnly(options.env || process.env);
  const client = createWhatsAppClient(options);

  const handleMessageCreate = createWhatsAppMessageHandler(io, client, options);

  // ── WhatsApp events ──────────────────────────────────────────────────────

  client.on('qr', (qr) => {
    const now = Date.now();
    store.lastQR       = qr;
    store.horaDeInicio = Math.floor(now / 1000);

    if (now - store.lastQRTime < store.QR_THROTTLE) return;
    store.lastQRTime = now;

    console.log('📱 QR de WhatsApp generado para administradores');
    io.to('admin').emit('qr', { qr, expiresIn: 20 });
  });

  client.on('ready', () => {
    console.log('✅ NEXO Bot listo — sistema operativo');
    store.lastQR       = null;
    store.horaDeInicio = Math.floor(Date.now() / 1000);
    io.to('admin').emit('bot-status', { status: 'ready' });
  });

  client.on('disconnected', (reason) => {
    console.warn('❌ Bot desconectado:', reason);
    io.to('admin').emit('bot-status', { status: 'disconnected', reason });
  });

  client.on('message_create', async (message) => {
    return handleMessageCreate(message);
  });

  return { client, borrarSesion };
}

module.exports = { setupWhatsApp, createWhatsAppClient, loadSessionsFromDb, createWhatsAppMessageHandler, estaEnHorarioLaboral };
