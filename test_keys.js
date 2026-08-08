const axios = require('axios');
require('dotenv').config();

async function testOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('❌ OpenAI Key: Not found in .env');
    return;
  }
  console.log('Testing OpenAI Key:', key.substring(0, 10) + '...');
  
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5
    }, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    console.log('✅ OpenAI Key: Success! Status 200.');
  } catch (e) {
    if (e.response) {
      console.error(`❌ OpenAI Key: Failed with status ${e.response.status}`);
      console.error('Error Details:', e.response.data.error?.message || e.response.data);
    } else {
      console.error('❌ OpenAI Key: Network Error:', e.message);
    }
  }
}

async function testGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('❌ Gemini Key: Not found in .env');
    return;
  }
  console.log('\nTesting Gemini Key:', key.substring(0, 10) + '...');
  
  const models = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3.6-flash'
  ];
  for (const model of models) {
    try {
      const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        contents: [{ parts: [{ text: "hi" }] }]
      });
      console.log(`✅ Gemini Key (${model}): Success! Status 200.`);
    } catch (e) {
      if (e.response) {
        console.error(`❌ Gemini Key (${model}): Failed - ${e.response.data.error?.message || e.response.status}`);
      } else {
        console.error(`❌ Gemini Key (${model}): Network Error - ${e.message}`);
      }
    }
  }
}

async function runTests() {
  console.log('====================================');
  console.log('API KEY TESTING TOOL');
  console.log('====================================');
  await testOpenAI();
  await testGemini();
  console.log('====================================');
}

runTests();
