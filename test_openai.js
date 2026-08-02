const axios = require('axios');
require('dotenv').config();

async function testOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  console.log('Testing OpenAI Key:', key.substring(0, 7) + '...');
  
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }]
    }, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    console.log('Success! Model used:', res.data.model);
  } catch (e) {
    if (e.response) {
      console.error('Error Status:', e.response.status);
      console.error('Error Data:', JSON.stringify(e.response.data, null, 2));
    } else {
      console.error('Network Error:', e.message);
    }
  }
}

testOpenAI();
