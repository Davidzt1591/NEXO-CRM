const axios = require('axios');

const META_API_URL = 'https://graph.facebook.com/v18.0';

async function sendMessage(to, message) {
  const url = `${META_API_URL}/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: message }
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error enviando mensaje:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { sendMessage };