const axios = require('axios');
require('dotenv').config();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

async function testGemini() {
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro'];
  console.log('🔑 Gemini Key:', GEMINI_KEY ? GEMINI_KEY.substring(0, 10) + '...' : '❌ MISSING');

  for (const model of models) {
    try {
      console.log(`\nTesting model: ${model}...`);
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        { contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      if (res.data.candidates) {
        console.log(`✅ ${model}: OK -`, res.data.candidates[0]?.content?.parts[0]?.text?.slice(0, 50));
      }
    } catch (e) {
      const err = e.response?.data?.error;
      console.log(`❌ ${model}: ${err?.status || e.code} - ${err?.message || e.message}`);
    }
  }
}

async function testOpenAI() {
  console.log('\n🔑 OpenAI Key:', OPENAI_KEY ? OPENAI_KEY.substring(0, 10) + '...' : '❌ MISSING');
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { headers: { 'Authorization': `Bearer ${OPENAI_KEY}` }, timeout: 15000 }
    );
    console.log('✅ OpenAI gpt-4o-mini: OK -', res.data.choices[0]?.message?.content);
  } catch (e) {
    const err = e.response?.data?.error;
    console.log(`❌ OpenAI: ${e.response?.status || e.code} - ${err?.message || e.message}`);
  }
}

(async () => {
  await testGemini();
  await testOpenAI();
  console.log('\nDone ✅');
})();
