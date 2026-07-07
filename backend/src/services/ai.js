const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

async function analizarPrioridad(situacion) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Analiza la urgencia técnica del siguiente requerimiento: "${situacion}". Responde únicamente con una de estas palabras: Alta, Media o Baja.`;
    const result = await model.generateContent(prompt);
    const texto = result.response.text().trim();
    if (['Alta', 'Media', 'Baja'].includes(texto)) return texto;
    return 'Media';
  } catch (e) {
    console.error('Error Gemini (Analizar Prioridad):', e.message);
    return 'Media';
  }
}

async function resumirConversacion(mensajes) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Eres un asistente experto de Service Desk. Recibirás un historial de chat entre un bot/agente y un cliente. Resume el caso en máximo 3 líneas marcadas (bullet points). El primer bullet point debe ser el "Problema principal", el segundo "Sentimiento del Cliente", el tercero "Estado o Siguiente paso".\n\nHistorial:\n${mensajes}`;
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.error('Error resumiendo conversación:', e.message);
    return 'No se pudo generar el resumen en este momento.';
  }
}

async function mejorarGramatica(texto) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Corrige ortografía, mejora la gramática y dale un tono profesional, amable y empático de servicio al cliente al siguiente texto. No agregues saludos ni explicaciones extras, simplemente devuelve el texto mejorado listo para enviar:\n\n"${texto}"`;
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.error('Error mejorando gramática:', e.message);
    return texto;
  }
}

module.exports = {
  analizarPrioridad,
  resumirConversacion,
  mejorarGramatica
};
