const axios = require('axios');
require('dotenv').config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

async function sendPopup() {
  console.log(`Sending activation message to Admin ID: ${ADMIN_ID}...`);
  try {
    const res = await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: ADMIN_ID,
      text: "✨ <b>ExamVault Bot Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\n🚀 Your ExamVault Telegram Bot is up and running!\n\nTap below or send <code>/start</code> in Telegram to access your practice dashboard.",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎯 Take Test Now", callback_data: "take_test" }],
          [{ text: "📚 Schedule Test", callback_data: "schedule_test" }],
          [{ text: "⚙️ Main Menu", callback_data: "main_menu" }]
        ]
      }
    });

    if (res.data && res.data.ok) {
      console.log("✅ Message sent successfully!");
      console.log("Message Details:", res.data.result);
    } else {
      console.error("❌ Response error:", res.data);
    }
  } catch (err) {
    if (err.response) {
      console.error("❌ API Error:", err.response.data);
    } else {
      console.error("❌ Network/Error:", err.message);
    }
  }
}

sendPopup();
