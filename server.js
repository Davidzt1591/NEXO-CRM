require('dotenv').config();
const express = require('express');
const supabase = require('./src/config/supabase');
const { analyzeMessage } = require('./src/services/geminiService');
const { sendMessage } = require('./src/services/whatsappService');

const app = express();
const PORT = process.env.PORT || 3000;

// Función para procesar mensaje entrante
async function processIncomingMessage(from, msg_body) {
  try {
    // Analizar con Gemini
    const analysis = await analyzeMessage(msg_body);
    console.log('Análisis IA:', analysis);

    // Buscar o crear ticket para este analista
    let { data: ticket, error: ticketError } = await supabase
      .from('tickets')
      .select('*')
      .eq('analyst_phone', from)
      .eq('status', 'open')
      .single();

    if (ticketError && ticketError.code !== 'PGRST116') { // PGRST116 es no encontrado
      throw ticketError;
    }

    if (!ticket) {
      // Crear nuevo ticket
      const { data: newTicket, error: newTicketError } = await supabase
        .from('tickets')
        .insert({
          analyst_phone: from,
          status: 'open',
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (newTicketError) throw newTicketError;
      ticket = newTicket;
    }

    // Guardar mensaje
    const { error: msgError } = await supabase
      .from('messages')
      .insert({
        ticket_id: ticket.id,
        from_user: true, // true si es del analista
        body: msg_body,
        timestamp: new Date().toISOString(),
        ai_analysis: analysis
      });

    if (msgError) throw msgError;

    console.log('Mensaje guardado en Supabase');
  } catch (error) {
    console.error('Error procesando mensaje:', error);
  }
}

// Ruta de verificación del webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Ruta para recibir mensajes (POST)
app.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object) {
    if (body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages &&
        body.entry[0].changes[0].value.messages[0]) {

      const phone_number_id = body.entry[0].changes[0].value.metadata.phone_number_id;
      const from = body.entry[0].changes[0].value.messages[0].from;
      const msg_body = body.entry[0].changes[0].value.messages[0].text.body;

      console.log('Mensaje recibido:', { from, msg_body });

      // Procesar el mensaje
      processIncomingMessage(from, msg_body);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Ruta para enviar mensaje (desde el panel)
app.post('/send-message', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Faltan parámetros: to y message' });
  }

  try {
    const result = await sendMessage(to, message);

    // Guardar el mensaje enviado en Supabase
    // Asumir que hay un ticket abierto
    const { data: ticket } = await supabase
      .from('tickets')
      .select('*')
      .eq('analyst_phone', to)
      .eq('status', 'open')
      .single();

    if (ticket) {
      await supabase
        .from('messages')
        .insert({
          ticket_id: ticket.id,
          from_user: false, // false si es respuesta nuestra
          body: message,
          timestamp: new Date().toISOString()
        });
    }

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});