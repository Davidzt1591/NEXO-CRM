const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs     = require('fs');
const path   = require('path');
const store  = require('../../store');
const db     = require('../../database/db');
const { analizarPrioridad } = require('../ai');
const { crearCase }         = require('../salesforce');
const botFlow               = require('../botFlow');
const { emitOperational }   = require('../../realtime/operational');
const routing               = require('../routing');
const { validateWhatsAppMedia } = require('../mediaValidation');
const { uploadWhatsAppMediaForTicket } = require('../salesforceMedia');

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
  try {
    const rows = await db.loadAllSessions();
    for (const row of rows) {
      store.sesiones[row.chat_id] = {
        paso:      row.paso,
        nombre:    row.nombre    || undefined,
        empresa:   row.empresa   || undefined,
        correo:    row.correo    || undefined,
        situacion: row.situacion || undefined,
        ticketId:  row.ticket_id || undefined,
        flowVersionId: row.flow_version_id || undefined,
      };
    }
    if (rows.length > 0) {
      console.log(`📥 ${rows.length} sesiones activas recuperadas desde Supabase`);
    }
  } catch (err) {
    console.error('❌ Error al cargar sesiones de Supabase:', err.message);
  }
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

  const areaId = await resolveTicketArea(ticketId);
  emitOperational(io, 'new-message', {
    chatId:      cid,
    ticketId,
    message:     texto,
    waMessageId: sent?.id?._serialized || null,
    from_user:   false,
    is_bot:      true,
    timestamp,
    id:          savedId,
  }, areaId);
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

    const areaId = await resolveTicketArea(sesion?.ticketId || null);
    emitOperational(io, 'new-message', {
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
    }, areaId);

    if (!store.botActivo)                            return;
    if (store.silenciados.has(chatId))               return;
    if (store.chatModes.get(chatId) === 'manual')    return;
    if (message.hasMedia && !texto)                  return;

    if (!isBusinessHours()) {
      await respuestaFlujo(io, message, 'out_of_office', {}, sesion?.ticketId || null);
      return;
    }

    if (!store.sesiones[chatId]) {
      store.sesiones[chatId] = { paso: 0 };
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, 'initial_filter');
      return;
    }

    const s = store.sesiones[chatId];

    if (s.paso === 0) {
      if (texto.toLowerCase().includes('si')) {
        s.paso = 1;
        await syncSessionToDb(chatId);
        await respuestaFlujo(io, message, 'ask_name');
      } else {
        s.paso = 'filtro_no';
        await syncSessionToDb(chatId);
        await respuestaFlujo(io, message, 'filter_no_menu');
      }
      return;
    }

    if (s.paso === 'filtro_no') {
      if (texto === '1') {
        await respuestaFlujo(io, message, 'filter_no_analyst');
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      } else if (texto === '2') {
        await respuestaFlujo(io, message, 'filter_no_candidate');
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      } else {
        await respuestaFlujo(io, message, 'filter_no_invalid');
      }
      return;
    }

    if (s.paso === 1) {
      s.nombre = texto;
      s.paso   = 2;
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, 'ask_company', { nombre: s.nombre });

    } else if (s.paso === 2) {
      s.empresa = texto;
      s.paso    = 3;
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, 'ask_email');

    } else if (s.paso === 3) {
      s.correo = texto;
      s.paso   = 4;
      await syncSessionToDb(chatId);
      await respuestaFlujo(io, message, 'ask_issue');

    } else if (s.paso === 4) {
      s.situacion = texto;
      await respuestaFlujo(io, message, 'processing');

      try {
        const prioridad = await analizarPrioridad(s.situacion);
        const phone     = realPhone || chatId.replace(/@c\.us|@lid/g, '');

        const ticket = await db.createTicket({
          chat_id:        chatId,
          telefono:       phone,
          nombre_analista: s.nombre,
          nombre_empresa:  s.empresa,
          correo:          s.correo,
          situacion:       s.situacion,
          prioridad,
        });

        s.ticketId = ticket.id;
        s.paso     = 5;
        await syncSessionToDb(chatId);

        const routedTicket = await routing.autoRouteTicket(db, ticket);
        emitOperational(io, 'ticket-created', routedTicket || ticket, (routedTicket || ticket).area_id || null);
        if (routedTicket?.assignment?.analyst_id) {
          emitOperational(io, 'ticket-assigned', routedTicket, routedTicket.area_id || null);
        }

        let sfCaseNumber = null;
        let sfCaseId     = null;
        try {
          const sfResult = await crearCase({
            Subject:       `Caso NEXO — ${s.nombre || chatId}`,
            Description:   s.situacion,
            SuppliedName:  s.nombre  || '',
            SuppliedEmail: s.correo  || '',
            SuppliedPhone: phone,
            Status:        'Asignado',
          });
          sfCaseNumber = sfResult.CaseNumber;
          sfCaseId     = sfResult.id;

          await db.updateTicketSalesforce(ticket.id, { sf_case_id: sfCaseId, sf_case_number: sfCaseNumber });

          emitOperational(io, 'sf-case-created', {
            contactKey:     String(ticket.id),
            sf_case_id:     sfCaseId,
            sf_case_number: sfCaseNumber,
          }, (routedTicket || ticket).area_id || null);
        } catch (sfErr) {
          console.warn('⚠️ Salesforce no disponible, ticket local creado:', sfErr.message);
        }

        const radicado = sfCaseNumber
          ? `Número de caso Salesforce: *#${sfCaseNumber}*`
          : `Número de caso interno: *${String(ticket.id)}*`;

        await respuestaFlujo(io, message, 'confirmation', { radicado, ticketId: ticket.id, sfCaseNumber, sfCaseId }, ticket.id);

      } catch (err) {
        console.error('❌ Error creando ticket:', err.message);
        await respuestaFlujo(io, message, 'ticket_error');
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      }
    }
  };
}

// ── Main setup ─────────────────────────────────────────────────────────────

function setupWhatsApp(io) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
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

  // Restore sessions persisted from last run
  loadSessionsFromDb();

  const handleMessageCreate = createWhatsAppMessageHandler(io, client);

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

    // Get real phone number
    let realPhone = null;
    try {
      const contact = await client.getContactById(chatId);
      if (contact?.number) realPhone = contact.number;
    } catch (_) { /* fallback to chatId */ }

    // Download media if present
    let mediaPayload = null;
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          mediaPayload = {
            data:     media.data,
            mimetype: media.mimetype,
            filename: media.filename || '',
          };
        }
      } catch (e) {
        console.warn('⚠️  Media download error:', e.message);
      }
    }

    const displayBody = texto || (mediaPayload
      ? `[${mediaPayload.mimetype?.split('/')[0] || 'media'}]`
      : '');

    const sesion = store.sesiones[chatId];

    // Persist message if ticket exists
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

    // Emit incoming message to scoped admin/area rooms when ticket area exists.
    const areaId = await resolveTicketArea(sesion?.ticketId || null);
    emitOperational(io, 'new-message', {
      chatId,
      ticketId:    sesion?.ticketId || null,
      message:     displayBody,
      media:       mediaPayload,
      waMessageId: message.id._serialized,
      from_user:   true,
      is_bot:      false,
      timestamp:   new Date().toISOString(),
      id:          savedId,
    }, areaId);

    // ── Guards ───────────────────────────────────────────────────────────
    if (!store.botActivo)                            return;
    if (store.silenciados.has(chatId))               return;
    if (store.chatModes.get(chatId) === 'manual')    return;
    if (message.hasMedia && !texto)                  return;

    // ── Out of office ────────────────────────────────────────────────────
    if (!estaEnHorarioLaboral()) {
      await respuestaFlujo(message, 'out_of_office', {}, sesion?.ticketId || null);
      return;
    }

    // ── New session ──────────────────────────────────────────────────────
    if (!store.sesiones[chatId]) {
      store.sesiones[chatId] = { paso: 0 };
      await syncSessionToDb(chatId);
      await respuestaFlujo(message, 'initial_filter');
      await syncSessionToDb(chatId);
      return;
    }

    const s = store.sesiones[chatId];

    // ── Flow step 0: initial filter ──────────────────────────────────────
    if (s.paso === 0) {
      if (texto.toLowerCase().includes('si')) {
        s.paso = 1;
        await syncSessionToDb(chatId);
        await respuestaFlujo(message, 'ask_name');
      } else {
        s.paso = 'filtro_no';
        await syncSessionToDb(chatId);
        await respuestaFlujo(message, 'filter_no_menu');
      }
      return;
    }

    // ── Flow step filtro_no: analyst/candidate redirect ──────────────────
    if (s.paso === 'filtro_no') {
      if (texto === '1') {
        await respuestaFlujo(message, 'filter_no_analyst');
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      } else if (texto === '2') {
        await respuestaFlujo(message, 'filter_no_candidate');
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      } else {
        await respuestaFlujo(message, 'filter_no_invalid');
      }
      return;
    }

    // ── Flow steps 1–4: data collection ─────────────────────────────────
    if (s.paso === 1) {
      s.nombre = texto;
      s.paso   = 2;
      await syncSessionToDb(chatId);
      await respuestaFlujo(message, 'ask_company', { nombre: s.nombre });

    } else if (s.paso === 2) {
      s.empresa = texto;
      s.paso    = 3;
      await syncSessionToDb(chatId);
      await respuestaFlujo(message, 'ask_email');

    } else if (s.paso === 3) {
      s.correo = texto;
      s.paso   = 4;
      await syncSessionToDb(chatId);
      await respuestaFlujo(message, 'ask_issue');

    } else if (s.paso === 4) {
      s.situacion = texto;
      await respuestaFlujo(message, 'processing');

      try {
        const prioridad = await analizarPrioridad(s.situacion);
        const phone     = realPhone || chatId.replace(/@c\.us|@lid/g, '');

        // ── Save ticket to Supabase ──────────────────────────────────────
        const ticket = await db.createTicket({
          chat_id:        chatId,
          telefono:       phone,
          nombre_analista: s.nombre,
          nombre_empresa:  s.empresa,
          correo:          s.correo,
          situacion:       s.situacion,
          prioridad,
        });

        s.ticketId = ticket.id;
        s.paso     = 5;
        await syncSessionToDb(chatId);

        const routedTicket = await routing.autoRouteTicket(db, ticket);
        emitOperational(io, 'ticket-created', routedTicket || ticket, (routedTicket || ticket).area_id || null);
        if (routedTicket?.assignment?.analyst_id) {
          emitOperational(io, 'ticket-assigned', routedTicket, routedTicket.area_id || null);
        }

        // ── Create Salesforce Case ─────────────────────────────────────
        let sfCaseNumber = null;
        let sfCaseId     = null;
        try {
          const sfResult = await crearCase({
            Subject:       `Caso NEXO — ${s.nombre || chatId}`,
            Description:   s.situacion,
            SuppliedName:  s.nombre  || '',
            SuppliedEmail: s.correo  || '',
            SuppliedPhone: phone,
            Status:        'Asignado',
          });
          sfCaseNumber = sfResult.CaseNumber;
          sfCaseId     = sfResult.id;

          // Update local ticket with SF reference
          await db.updateTicketSalesforce(ticket.id, { sf_case_id: sfCaseId, sf_case_number: sfCaseNumber });

          emitOperational(io, 'sf-case-created', {
            contactKey:     String(ticket.id),
            sf_case_id:     sfCaseId,
            sf_case_number: sfCaseNumber,
          }, (routedTicket || ticket).area_id || null);
        } catch (sfErr) {
          console.warn('⚠️ Salesforce no disponible, ticket local creado:', sfErr.message);
        }

        const radicado = sfCaseNumber
          ? `Número de caso Salesforce: *#${sfCaseNumber}*`
          : `Número de caso interno: *${String(ticket.id)}*`;

        await respuestaFlujo(message, 'confirmation', { radicado, ticketId: ticket.id, sfCaseNumber, sfCaseId }, ticket.id);

      } catch (err) {
        console.error('❌ Error creando ticket:', err.message);
        await respuestaFlujo(message, 'ticket_error');
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      }
    }
  });

  return { client, borrarSesion };
}

module.exports = { setupWhatsApp, createWhatsAppMessageHandler, estaEnHorarioLaboral };
