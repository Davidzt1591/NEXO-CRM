const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

async function analyzeMessage(message) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `
Analiza el siguiente mensaje de un analista de soporte y extrae la siguiente información en formato JSON:

Mensaje: "${message}"

Devuelve un JSON con:
- urgency: "low", "medium", "high" (basado en palabras clave de urgencia como "urgente", "error crítico", etc.)
- category: "API", "Accesos", "Dudas", "Otro" (clasifica el problema)
- summary: Un resumen breve del mensaje (máximo 50 palabras)

Ejemplo de respuesta:
{
  "urgency": "high",
  "category": "API",
  "summary": "El analista reporta un error crítico en la API de autenticación."
}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Intentar parsear el JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('No se pudo extraer JSON de la respuesta de Gemini');
    }
  } catch (error) {
    console.error('Error analizando mensaje con Gemini:', error);
    return {
      urgency: 'medium',
      category: 'Otro',
      summary: 'Error en análisis automático'
    };
  }
}

module.exports = { analyzeMessage };