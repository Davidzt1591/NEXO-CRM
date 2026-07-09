const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// Legacy entrypoint: credentials must be supplied through environment variables.
const requiredEnv = ['GOOGLE_GENERATIVE_AI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    throw new Error(`Missing required environment variables for legacy bot entrypoint: ${missingEnv.join(', ')}`);
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const sesiones = {};
const horaDeInicio = Math.floor(Date.now() / 1000);

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions', '--disable-notifications'],
        headless: true 
    }
});

// --- FUNCIÓN DE CONTROL DE HORARIO ---
function estaEnHorarioLaboral() {
    const ahora = new Date();
    const dia = ahora.getDay(); // 0: Domingo, 1: Lunes... 6: Sábado
    const hora = ahora.getHours();
    const minutos = ahora.getMinutes();
    const tiempoActual = hora + minutos / 60;

    // Lunes (1) a Jueves (4): 7am a 5pm
    if (dia >= 1 && dia <= 4) {
        return tiempoActual >= 7 && tiempoActual < 17;
    }
    // Viernes (5): 7am a 4pm
    if (dia === 5) {
        return tiempoActual >= 7 && tiempoActual < 16;
    }
    // Sábado y Domingo
    return false;
}

client.on('qr', qr => { qrcode.generate(qr, { small: true }); });

client.on('ready', () => { 
    console.log('🚀 SISTEMA MAGNETO365 OPERATIVO - FLUJO PROFESIONAL ACTIVADO'); 
});

client.on('message_create', async (message) => {
    if (message.fromMe || message.from.includes('@g.us')) return;

    // Solo mensajes nuevos
    if (message.timestamp <= horaDeInicio) return;

    // --- VERIFICACIÓN DE HORARIO ---
    if (!estaEnHorarioLaboral()) {
        await message.reply(
            'Estimado usuario, gracias por contactar al área de Integraciones de *Magneto365*. 🌐\n\n' +
            'Le informamos que actualmente no nos encontramos en horario de atención. ' +
            'Una vez retomemos actividades, estaremos dando respuesta a su requerimiento. Gracias por su comprensión.'
        );
        return;
    }

    const remitente = message.from;
    const texto = message.body.trim();

    // --- INICIO DEL FLUJO PERSONALIZADO ---
    if (!sesiones[remitente]) {
        sesiones[remitente] = { paso: 0 };
        await message.reply(
            'Bienvenido al canal de soporte de Integraciones de *Magneto365*.\n\n' +
            'ℹ️ Te informamos que este canal es exclusivo para atención a dudas y novedades técnicas sobre tus integraciones.\n\n' +
            '¿Su requerimiento está relacionado con alguna integración? (Responda *SI* o *NO*)'
        );
        return;
    }

    const estado = sesiones[remitente];

    // PASO 0: Filtro Inicial
    if (estado.paso === 0) {
        if (texto.toLowerCase().includes('si')) {
            estado.paso = 1;
            await message.reply('Entendido. Procederemos con el registro. Por favor, indíqueme su *Nombre Completo*:');
        } else {
            estado.paso = 'filtro_no';
            await message.reply(
                'Para orientarlo correctamente, por favor indíquenos:\n\n' +
                'Escriba *1* si es *Analista*.\n' +
                'Escriba *2* si es *Candidato* o *Candidata*.'
            );
        }
        return;
    }

    // FLUJO PARA LOS QUE DIJERON "NO" (Filtro Analista/Candidato)
    if (estado.paso === 'filtro_no') {
        if (texto === '1') {
            await message.reply(
                '👨‍💻 *Atención a Analistas:*\n\n' +
                'Si presenta novedades con la plataforma, requiere soporte, resultados de candidatos o ayuda adicional, ' +
                'debe reportar su caso al correo: *soporte.mgt@magnetoglobal.com*.\n\n' +
                'Allí recibirá la atención oportuna. ¡Feliz día!'
            );
            delete sesiones[remitente];
        } else if (texto === '2') {
            await message.reply(
                '👋 *Atención a Candidatos:*\n\n' +
                'Si requiere soporte o ayuda con su proceso, debe escalar su solicitud a través de nuestro canal oficial: \n\n' +
                '🔗 https://static.magneto365.com/widgets/help/index.html\n\n' +
                '¡Muchos éxitos en su búsqueda laboral! ✨'
            );
            delete sesiones[remitente];
        } else {
            await message.reply('Por favor, responda *1* para Analista o *2* para Candidato.');
        }
        return;
    }

    // --- FLUJO NORMAL DE INTEGRACIONES ---
    if (estado.paso === 1) {
        estado.nombre = texto; estado.paso = 2;
        await message.reply(`Gracias, ${estado.nombre}. Indíqueme el nombre de la *Empresa o Cliente* afectado:`);
    } else if (estado.paso === 2) {
        estado.empresa = texto; estado.paso = 3;
        await message.reply('Proporcione su *Correo Electrónico Corporativo*:');
    } else if (estado.paso === 3) {
        estado.correo = texto; estado.paso = 4;
        await message.reply('Describa detalladamente su *Requerimiento Técnico o Incidencia*:');
    } else if (estado.paso === 4) {
        estado.situacion = texto;
        await message.reply('📋 *Procesando solicitud técnica en Magneto365...*');
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `Analiza la urgencia: "${estado.situacion}". Responde solo: Alta, Media o Baja.`;
            const result = await model.generateContent(prompt);
            const prioridad = result.response.text().trim();

            const { error } = await supabase.from('tickets').insert([{ 
                telefono: remitente, nombre_analista: estado.nombre, nombre_empresa: estado.empresa,
                correo: estado.correo, situacion: estado.situacion, prioridad: prioridad
            }]);

            if (error) throw error;
            await message.reply(`✅ *TICKET REGISTRADO EXITOSAMENTE*\n\nPrioridad Asignada: *${prioridad}*\n\nDavid y el equipo técnico han sido notificados.`);
            delete sesiones[remitente];
        } catch (err) { console.error(err); delete sesiones[remitente]; }
    }
});

client.initialize();
