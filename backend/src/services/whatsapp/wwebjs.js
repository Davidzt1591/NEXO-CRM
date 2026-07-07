const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs     = require('fs');
const path   = require('path');
const store  = require('../../store');
const db     = require('../../database/db');
const { analizarPrioridad } = require('../ai');
const { crearCase }         = require('../salesforce');

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
      };
    }
    if (rows.length > 0) {
      console.log(`📥 ${rows.length} sesiones activas recuperadas desde Supabase`);
    }
  } catch (err) {
    console.error('❌ Error al cargar sesiones de Supabase:', err.message);
  }
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

  // ── Bot reply helper ─────────────────────────────────────────────────────
  async function respuestaBot(message, texto, ticketId = null, chatId = null) {
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

    io.emit('new-message', {
      chatId:      cid,
      ticketId,
      message:     texto,
      waMessageId: sent?.id?._serialized || null,
      from_user:   false,
      is_bot:      true,
      timestamp,
      id:          savedId,
    });
  }

  // ── WhatsApp events ──────────────────────────────────────────────────────

  client.on('qr', (qr) => {
    const now = Date.now();
    store.lastQR       = qr;
    store.horaDeInicio = Math.floor(now / 1000);

    if (now - store.lastQRTime < store.QR_THROTTLE) return;
    store.lastQRTime = now;

    console.log('\n📱 Escanea el QR con WhatsApp:\n');
    qrcode.generate(qr, { small: true });
    io.emit('qr', { qr, expiresIn: 20 });
  });

  client.on('ready', () => {
    console.log('✅ NEXO Bot listo — sistema operativo');
    store.lastQR       = null;
    store.horaDeInicio = Math.floor(Date.now() / 1000);
    io.emit('bot-status', { status: 'ready' });
  });

  client.on('disconnected', (reason) => {
    console.warn('❌ Bot desconectado:', reason);
    io.emit('bot-status', { status: 'disconnected', reason });
  });

  client.on('message_create', async (message) => {
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

    // Emit incoming message to dashboard
    io.emit('new-message', {
      chatId,
      ticketId:    sesion?.ticketId || null,
      message:     displayBody,
      media:       mediaPayload,
      waMessageId: message.id._serialized,
      from_user:   true,
      is_bot:      false,
      timestamp:   new Date().toISOString(),
    });

    // Persist message if ticket exists
    if (sesion?.ticketId) {
      await db.saveMessage({
        ticket_id:    sesion.ticketId,
        chat_id:      chatId,
        body:         displayBody,
        from_user:    true,
        is_bot:       false,
        wa_message_id: message.id._serialized,
      });
    }

    // ── Guards ───────────────────────────────────────────────────────────
    if (!store.botActivo)                            return;
    if (store.silenciados.has(chatId))               return;
    if (store.chatModes.get(chatId) === 'manual')    return;
    if (message.hasMedia && !texto)                  return;

    // ── Out of office ────────────────────────────────────────────────────
    if (!estaEnHorarioLaboral()) {
      await respuestaBot(
        message,
        'Estimado usuario, gracias por contactar al área de Integraciones de *Magneto365*. 🌐\n\n' +
        'Le informamos que actualmente no nos encontramos en horario de atención. ' +
        'Una vez retomemos actividades, estaremos dando respuesta a su requerimiento. Gracias por su comprensión.',
        sesion?.ticketId || null
      );
      return;
    }

    // ── New session ──────────────────────────────────────────────────────
    if (!store.sesiones[chatId]) {
      store.sesiones[chatId] = { paso: 0 };
      await syncSessionToDb(chatId);
      await respuestaBot(
        message,
        'Bienvenido al canal de soporte de Integraciones de *Magneto365*.\n\n' +
        'ℹ️ Este canal es exclusivo para atención a dudas y novedades técnicas sobre integraciones.\n\n' +
        '¿Su requerimiento está relacionado con alguna integración? (Responda *SI* o *NO*)'
      );
      return;
    }

    const s = store.sesiones[chatId];

    // ── Flow step 0: initial filter ──────────────────────────────────────
    if (s.paso === 0) {
      if (texto.toLowerCase().includes('si')) {
        s.paso = 1;
        await syncSessionToDb(chatId);
        await respuestaBot(message, 'Entendido. Procederemos con el registro. Por favor, indíqueme su *Nombre Completo*:');
      } else {
        s.paso = 'filtro_no';
        await syncSessionToDb(chatId);
        await respuestaBot(
          message,
          'Para orientarlo correctamente, por favor indíquenos:\n\n' +
          'Escriba *1* si es *Analista*.\n' +
          'Escriba *2* si es *Candidato* o *Candidata*.'
        );
      }
      return;
    }

    // ── Flow step filtro_no: analyst/candidate redirect ──────────────────
    if (s.paso === 'filtro_no') {
      if (texto === '1') {
        await respuestaBot(
          message,
          '👨‍💻 *ZONA DE ANALISTAS - MAGNETO365*\n\n' +
          'Para brindarte un soporte técnico seguro y garantizado, todas tus consultas y reportes deben registrarse mediante nuestro buzón oficial.\n\n' +
          '📧 *Envíanos un correo directamente a:*\n' +
          'soporte.mgt@magnetoglobal.com\n\n' +
          'Uno de nuestros asesores de soporte tomará tu caso y te contactará. ¡Feliz día! ✨'
        );
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      } else if (texto === '2') {
        await respuestaBot(
          message,
          '👋 *Atención a Candidatos:*\n\n' +
          'Si requiere soporte o ayuda con su proceso, debe escalar su solicitud a través de nuestro canal oficial:\n\n' +
          '🔗 https://static.magneto365.com/widgets/help/index.html\n\n' +
          '¡Muchos éxitos en su búsqueda laboral! ✨'
        );
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      } else {
        await respuestaBot(message, 'Por favor, responda *1* para Analista o *2* para Candidato.');
      }
      return;
    }

    // ── Flow steps 1–4: data collection ─────────────────────────────────
    if (s.paso === 1) {
      s.nombre = texto;
      s.paso   = 2;
      await syncSessionToDb(chatId);
      await respuestaBot(message, `Gracias, ${s.nombre}. Indíqueme el nombre de la *Empresa o Cliente* afectado:`);

    } else if (s.paso === 2) {
      s.empresa = texto;
      s.paso    = 3;
      await syncSessionToDb(chatId);
      await respuestaBot(message, 'Proporcione su *Correo Electrónico Corporativo*:');

    } else if (s.paso === 3) {
      s.correo = texto;
      s.paso   = 4;
      await syncSessionToDb(chatId);
      await respuestaBot(message, 'Describa detalladamente su *Requerimiento Técnico o Incidencia*:');

    } else if (s.paso === 4) {
      s.situacion = texto;
      await respuestaBot(message, '📋 *Procesando solicitud técnica en Magneto365...*');

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

        io.emit('ticket-created', ticket);

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

          io.emit('sf-case-created', {
            contactKey:     String(ticket.id),
            sf_case_id:     sfCaseId,
            sf_case_number: sfCaseNumber,
          });
        } catch (sfErr) {
          console.warn('⚠️ Salesforce no disponible, ticket local creado:', sfErr.message);
        }

        const radicado = sfCaseNumber
          ? `Número de caso Salesforce: *#${sfCaseNumber}*`
          : `Número de caso interno: *${String(ticket.id)}*`;

        await respuestaBot(
          message,
          `✅ *SOLICITUD RECIBIDA*\n\n` +
          `El equipo técnico de Integraciones ha sido notificado sobre tu novedad.\n` +
          `${radicado}\n\n` +
          `Un asesor revisará tu caso y te contactará pronto por este medio. ¡Gracias!`,
          ticket.id
        );

      } catch (err) {
        console.error('❌ Error creando ticket:', err.message);
        await respuestaBot(
          message,
          '⚠️ Ocurrió un error al registrar su solicitud. Por favor intente nuevamente o contacte a soporte.mgt@magnetoglobal.com'
        );
        delete store.sesiones[chatId];
        await syncSessionToDb(chatId);
      }
    }
  });

  return { client, borrarSesion };
}

module.exports = { setupWhatsApp };
