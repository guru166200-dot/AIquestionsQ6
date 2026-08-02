#!/usr/bin/env node

/**
 * EXAMVAULT ADVANCED TELEGRAM BOT
 * 
 * Features:
 * - User inputs topic the night before
 * - AI generates questions at 7 AM
 * - Questions saved to Notion (nested structure)
 * - Schedule management per user
 * - Automatic quiz at scheduled time
 */

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const cron = require('node-cron');
const http = require('http'); // Required for health checks on Render
require('dotenv').config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_PARENT_DB = process.env.NOTION_PARENT_DB;
let GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;

// Global tracker for automatic model selection
let LAST_WORKING_GEMINI_MODEL = null;


// Validation for deployment
if (!TOKEN) {
  console.error("❌ ERROR: TELEGRAM_BOT_TOKEN is missing in environment variables!");
  process.exit(1);
}
if (!NOTION_KEY || !NOTION_PARENT_DB) {
  console.warn("⚠️ WARNING: Notion credentials are not fully set. Notion features might fail.");
}
if (!GEMINI_API_KEY && !OPENAI_API_KEY) {
  console.warn("⚠️ WARNING: No AI API keys (Gemini/OpenAI) found. Question generation will fail.");
}

function updateEnvFile(key, value) {
  try {
    process.env[key] = value;
    let envContent = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';

    const regex = new RegExp(`^${key}=.*`, 'm');
    if (envContent.match(regex)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
    fs.writeFileSync('.env', envContent.trim() + '\n', 'utf8');
  } catch (err) {
    console.error('Error writing to .env:', err.message);
  }
}

const bot = new TelegramBot(TOKEN, { polling: true });

// Helper to escape HTML for Telegram
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


// ==================== STATE MANAGEMENT ====================

// User scheduled topics: { userId: { topic, exam, date, status } }
const userSchedules = new Map();

// Active quizzes: { chatId: { questions, current, score, topic, wrongAnswers } }
const activeQuizzes = new Map();

// Temporary topic input: { chatId: { exam, topic, step } }
const topicInput = new Map();

// Performance stats: { userId: { totalTests, totalQuestions, totalCorrect, byExam: {} } }
const userStats = new Map();

// Wrong answer review sessions: { chatId: { wrong: [], current: 0 } }
const reviewSessions = new Map();

// Starred questions: { userId: [ { q, exam, subject, topic } ] }
const userBookmarks = new Map();

// Target Exam Dates for Countdown Dashboard: { userId: { exam, targetDate, dailyTarget } }
const userExamDates = new Map();

// Saved Flashcards: { userId: [ { term, definition, subject, exam, box, lastReviewed } ] }
const userFlashcards = new Map();

// Active AI Tutor Sessions: { chatId: { active: true, startTime: number } }
const activeTutorSessions = new Map();

// Active Mock / PYQ Exams: { chatId: { title, questions, current, userAnswers: [], startTime, exam, isPyq } }
const activeMockExams = new Map();

// Active Flashcard Review Sessions: { chatId: { cards: [], current: 0, showingAnswer: boolean } }
const activeFlashcardSessions = new Map();

// Pinned status messages: { chatId: messageId }
const pinnedMessagesMap = new Map();

function savePinnedTokens() {
  try {
    const data = JSON.stringify(Array.from(pinnedMessagesMap.entries()), null, 2);
    fs.writeFileSync('pinned_tokens.json', data, 'utf8');
  } catch (err) {
    console.error('Error saving pinned tokens:', err.message);
  }
}

function loadPinnedTokens() {
  try {
    if (fs.existsSync('pinned_tokens.json')) {
      const data = fs.readFileSync('pinned_tokens.json', 'utf8');
      const entries = JSON.parse(data);
      for (const [key, val] of entries) pinnedMessagesMap.set(key, val);
      console.log(`📌 Loaded pinned tokens for ${pinnedMessagesMap.size} users.`);
    }
  } catch (err) {
    console.error('Error loading pinned tokens:', err.message);
  }
}

let cachedTokenStatus = null;
let lastCheckTime = 0;

async function getLiveTokenStatus(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedTokenStatus && (now - lastCheckTime < 30000)) {
    return cachedTokenStatus;
  }

  const status = {
    gemini: { ok: false, details: 'Checking...' },
    groq: { ok: false, details: 'Checking...' },
    openai: { ok: false, details: 'Checking...' },
    notion: { ok: false, details: 'Checking...' },
    updatedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  // 1. Gemini
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    status.gemini = { ok: false, details: '❌ Key Missing' };
  } else {
    try {
      const model = LAST_WORKING_GEMINI_MODEL || 'gemini-3.6-flash';
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        { contents: [{ parts: [{ text: 'hi' }] }] },
        { timeout: 5000 }
      );
      if (res.data.candidates) {
        status.gemini = { ok: true, details: `🟢 ACTIVE (${model})` };
      }
    } catch (e) {
      const err = e.response?.data?.error?.message || e.message;
      if (err.includes('quota') || e.response?.status === 429) {
        status.gemini = { ok: false, details: '🔴 Quota Exceeded' };
      } else if (err.includes('API key not valid') || err.includes('invalid')) {
        status.gemini = { ok: false, details: '❌ Invalid Key' };
      } else {
        status.gemini = { ok: false, details: `⚠️ ${err.slice(0, 20)}` };
      }
    }
  }

  // 2. Groq
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    status.groq = { ok: false, details: '❌ Key Missing' };
  } else {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 },
        { headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
      if (res.data.choices) {
        status.groq = { ok: true, details: '🟢 ACTIVE (Llama 3.3 70B)' };
      }
    } catch (e) {
      const err = e.response?.data?.error?.message || e.message;
      status.groq = { ok: false, details: err.includes('quota') ? '🔴 Quota Exceeded' : '❌ Key Error' };
    }
  }

  // 3. OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    status.openai = { ok: false, details: '❌ Key Missing' };
  } else {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 },
        { headers: { 'Authorization': `Bearer ${openaiKey}` }, timeout: 5000 }
      );
      if (res.data.choices) {
        status.openai = { ok: true, details: '🟢 ACTIVE' };
      }
    } catch (e) {
      const err = e.response?.data?.error?.message || e.message;
      status.openai = { ok: false, details: err.includes('quota') ? '🔴 Quota Exceeded' : '❌ Key Error' };
    }
  }

  // 4. Notion
  const notionKey = process.env.NOTION_API_KEY;
  const notionDb = process.env.NOTION_PARENT_DB;
  if (notionKey && notionDb) {
    status.notion = { ok: true, details: '🟢 CONNECTED' };
  } else {
    status.notion = { ok: false, details: '⚠️ Incomplete Config' };
  }

  cachedTokenStatus = status;
  lastCheckTime = now;
  return status;
}

// Token usage stats persistence — with per-model breakdown
let globalTokenStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  totalRequests: 0,
  lastTestTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, model: 'None' },
  // Per-model cumulative stats
  byModel: {
    gemini:  { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    groq:    { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    openai:  { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  }
};

function saveTokenStats() {
  try {
    fs.writeFileSync('token_stats.json', JSON.stringify(globalTokenStats, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving token stats:', err.message);
  }
}

function loadTokenStats() {
  try {
    if (fs.existsSync('token_stats.json')) {
      const data = fs.readFileSync('token_stats.json', 'utf8');
      const loaded = JSON.parse(data);
      // Merge, ensuring byModel always exists for new fields
      globalTokenStats = {
        ...globalTokenStats,
        ...loaded,
        byModel: {
          gemini:  { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, ...(loaded.byModel?.gemini || {}) },
          groq:    { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, ...(loaded.byModel?.groq   || {}) },
          openai:  { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, ...(loaded.byModel?.openai  || {}) }
        }
      };
      console.log(`🔤 Loaded token stats: ${globalTokenStats.totalTokens} total tokens used.`);
    }
  } catch (err) {
    console.error('Error loading token stats:', err.message);
  }
}

function recordTokenUsage(model, usage) {
  const p = usage.promptTokens || 0;
  const c = usage.completionTokens || 0;
  const t = usage.totalTokens || (p + c);

  globalTokenStats.totalPromptTokens += p;
  globalTokenStats.totalCompletionTokens += c;
  globalTokenStats.totalTokens += t;
  globalTokenStats.totalRequests += 1;
  globalTokenStats.lastTestTokens = { promptTokens: p, completionTokens: c, totalTokens: t, model };

  // Accumulate per-model
  const mLow = model.toLowerCase();
  let bucket;
  if (mLow.includes('gemini'))      bucket = 'gemini';
  else if (mLow.includes('groq'))   bucket = 'groq';
  else if (mLow.includes('chatgpt') || mLow.includes('openai') || mLow.includes('gpt')) bucket = 'openai';
  if (bucket) {
    globalTokenStats.byModel[bucket].requests      += 1;
    globalTokenStats.byModel[bucket].promptTokens  += p;
    globalTokenStats.byModel[bucket].completionTokens += c;
    globalTokenStats.byModel[bucket].totalTokens   += t;
  }

  saveTokenStats();
}

function formatLiveTokenCountMessage() {
  const g  = globalTokenStats;
  const bm = g.byModel;
  const last = g.lastTestTokens;

  // Bar helpers
  const bar = (val, max, len = 10) => {
    const filled = max > 0 ? Math.round((val / max) * len) : 0;
    return '█'.repeat(filled) + '░'.repeat(len - filled);
  };
  const pct = (val, total) => total > 0 ? ((val / total) * 100).toFixed(1) + '%' : '0%';

  const maxT = Math.max(bm.gemini.totalTokens, bm.groq.totalTokens, bm.openai.totalTokens, 1);

  const lastLine = last && last.totalTokens > 0
    ? `📌 <b>Last Generation</b>\n` +
      `   • Model: <code>${escapeHTML(last.model)}</code>\n` +
      `   • Prompt:     <code>${last.promptTokens.toLocaleString()} tokens</code>\n` +
      `   • Completion: <code>${last.completionTokens.toLocaleString()} tokens</code>\n` +
      `   • <b>Total: <code>${last.totalTokens.toLocaleString()} tokens</code></b>\n`
    : `📌 <b>Last Generation:</b> <i>None yet</i>\n`;

  const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  return (
    `🔢 <b>LIVE TOKEN COUNT DASHBOARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    lastLine +
    `\n` +
    `<b>📊 Cumulative Token Usage</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 <b>Gemini AI</b>  (${bm.gemini.requests} calls)\n` +
    `   <code>${bar(bm.gemini.totalTokens, maxT)} ${bm.gemini.totalTokens.toLocaleString()} tokens (${pct(bm.gemini.totalTokens, g.totalTokens)})</code>\n` +
    `   ↳ Prompt: <code>${bm.gemini.promptTokens.toLocaleString()}</code>  Completion: <code>${bm.gemini.completionTokens.toLocaleString()}</code>\n\n` +
    `🟣 <b>Groq (Llama)</b>  (${bm.groq.requests} calls)\n` +
    `   <code>${bar(bm.groq.totalTokens, maxT)} ${bm.groq.totalTokens.toLocaleString()} tokens (${pct(bm.groq.totalTokens, g.totalTokens)})</code>\n` +
    `   ↳ Prompt: <code>${bm.groq.promptTokens.toLocaleString()}</code>  Completion: <code>${bm.groq.completionTokens.toLocaleString()}</code>\n\n` +
    `🟢 <b>OpenAI (GPT)</b>  (${bm.openai.requests} calls)\n` +
    `   <code>${bar(bm.openai.totalTokens, maxT)} ${bm.openai.totalTokens.toLocaleString()} tokens (${pct(bm.openai.totalTokens, g.totalTokens)})</code>\n` +
    `   ↳ Prompt: <code>${bm.openai.promptTokens.toLocaleString()}</code>  Completion: <code>${bm.openai.completionTokens.toLocaleString()}</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>Grand Total</b>\n` +
    `   🔤 Tokens Used:    <code>${g.totalTokens.toLocaleString()}</code>\n` +
    `   📝 Prompt Tokens:  <code>${g.totalPromptTokens.toLocaleString()}</code>\n` +
    `   💬 Output Tokens:  <code>${g.totalCompletionTokens.toLocaleString()}</code>\n` +
    `   ⚡ Total AI Calls: <code>${g.totalRequests}</code>\n\n` +
    `🕒 <i>Updated: ${now}</i>`
  );
}

function formatPinnedTokenDashboardText(status) {
  const lastt = globalTokenStats.lastTestTokens;
  const lastFormatted = lastt && lastt.totalTokens > 0 
    ? `${lastt.totalTokens.toLocaleString()} tokens (${lastt.model})`
    : 'None yet';

  return `📌 <b>LIVE AI MODEL & TOKEN DASHBOARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>🤖 Active AI Providers:</b>\n` +
    `• 🔵 <b>Gemini AI:</b> ${status.gemini.details}\n` +
    `• 🟣 <b>Groq (Llama 3.3):</b> ${status.groq.details}\n` +
    `• 🟢 <b>OpenAI (GPT-4o):</b> ${status.openai.details}\n\n` +
    `<b>📊 Live Token Count & Usage:</b>\n` +
    `• 🔤 <b>Last Generation:</b> <code>${lastFormatted}</code>\n` +
    `• 📈 <b>Total Tokens Used:</b> <code>${globalTokenStats.totalTokens.toLocaleString()} tokens</code>\n` +
    `• ⚡ <b>Total AI Calls:</b> <code>${globalTokenStats.totalRequests} requests</code>\n\n` +
    `<b>📂 Notion Vault:</b> ${status.notion.details}\n` +
    `<b>⚡ Engine Status:</b> 🟢 ONLINE & POLLING\n` +
    `<b>🕒 Last Updated:</b> <code>${status.updatedAt}</code>\n\n` +
    `<i>📌 This message stays pinned to give you real-time live updates on your AI tokens and model quotas.</i>`;
}

async function updatePinnedTokenStatus(chatId, forceRefresh = false) {
  try {
    const status = await getLiveTokenStatus(forceRefresh);
    const text = formatPinnedTokenDashboardText(status);
    const pinnedMsgId = pinnedMessagesMap.get(chatId);

    if (pinnedMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: pinnedMsgId, parse_mode: 'HTML' });
        return pinnedMsgId;
      } catch (e) {
        // Message might have been deleted, proceed to recreate
      }
    }

    const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    pinnedMessagesMap.set(chatId, sent.message_id);
    savePinnedTokens();

    try {
      await bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
    } catch (pinErr) {
      console.warn(`Pinning error for ${chatId}:`, pinErr.message);
    }
    return sent.message_id;
  } catch (err) {
    console.error('Error in updatePinnedTokenStatus:', err.message);
  }
}

// Persistence Helpers
function saveSchedules() {
  try {
    const data = JSON.stringify(Array.from(userSchedules.entries()), null, 2);
    fs.writeFileSync('schedules.json', data, 'utf8');
  } catch (err) {
    console.error('Error saving schedules:', err.message);
  }
}

function loadSchedules() {
  try {
    if (fs.existsSync('schedules.json')) {
      const data = fs.readFileSync('schedules.json', 'utf8');
      const entries = JSON.parse(data);
      for (const [key, val] of entries) {
        if (val.scheduledFor) val.scheduledFor = new Date(val.scheduledFor);
        userSchedules.set(key, val);
      }
      console.log(`📂 Loaded ${userSchedules.size} schedules.`);
    }
  } catch (err) {
    console.error('Error loading schedules:', err.message);
  }
}

function isAdmin(chatId) {
  return ADMIN_ID && chatId === ADMIN_ID;
}

const allUsers = new Set();
function saveUsers() {
  try {
    const data = JSON.stringify(Array.from(allUsers), null, 2);
    fs.writeFileSync('users.json', data, 'utf8');
  } catch (err) {
    console.error('Error saving users:', err.message);
  }
}

function loadUsers() {
  try {
    if (fs.existsSync('users.json')) {
      const data = fs.readFileSync('users.json', 'utf8');
      const entries = JSON.parse(data);
      for (const userId of entries) {
        allUsers.add(userId);
      }
      console.log(`👥 Loaded ${allUsers.size} users.`);
    }
  } catch (err) {
    console.error('Error loading users:', err.message);
  }
}

function saveStats() {
  try {
    const data = JSON.stringify(Array.from(userStats.entries()), null, 2);
    fs.writeFileSync('stats.json', data, 'utf8');
  } catch (err) {
    console.error('Error saving stats:', err.message);
  }
}

function loadStats() {
  try {
    if (fs.existsSync('stats.json')) {
      const data = fs.readFileSync('stats.json', 'utf8');
      const entries = JSON.parse(data);
      for (const [key, val] of entries) userStats.set(key, val);
      console.log(`📊 Loaded stats for ${userStats.size} users.`);
    }
  } catch (err) {
    console.error('Error loading stats:', err.message);
  }
}

function saveBookmarks() {
  try {
    const data = JSON.stringify(Array.from(userBookmarks.entries()), null, 2);
    fs.writeFileSync('bookmarks.json', data, 'utf8');
  } catch (err) {
    console.error('Error saving bookmarks:', err.message);
  }
}

function loadBookmarks() {
  try {
    if (fs.existsSync('bookmarks.json')) {
      const data = fs.readFileSync('bookmarks.json', 'utf8');
      const entries = JSON.parse(data);
      for (const [key, val] of entries) userBookmarks.set(key, val);
      console.log(`🔖 Loaded bookmarks for ${userBookmarks.size} users.`);
    }
  } catch (err) {
    console.error('Error loading bookmarks:', err.message);
  }
}

function saveExamDates() {
  try {
    const data = JSON.stringify(Array.from(userExamDates.entries()), null, 2);
    fs.writeFileSync('exam_dates.json', data, 'utf8');
  } catch (err) {
    console.error('Error saving exam dates:', err.message);
  }
}

function loadExamDates() {
  try {
    if (fs.existsSync('exam_dates.json')) {
      const data = fs.readFileSync('exam_dates.json', 'utf8');
      const entries = JSON.parse(data);
      for (const [key, val] of entries) userExamDates.set(key, val);
      console.log(`📅 Loaded target exam dates for ${userExamDates.size} users.`);
    }
  } catch (err) {
    console.error('Error loading exam dates:', err.message);
  }
}

function saveFlashcards() {
  try {
    const data = JSON.stringify(Array.from(userFlashcards.entries()), null, 2);
    fs.writeFileSync('flashcards.json', data, 'utf8');
  } catch (err) {
    console.error('Error saving flashcards:', err.message);
  }
}

function loadFlashcards() {
  try {
    if (fs.existsSync('flashcards.json')) {
      const data = fs.readFileSync('flashcards.json', 'utf8');
      const entries = JSON.parse(data);
      for (const [key, val] of entries) userFlashcards.set(key, val);
      console.log(`🗃️ Loaded flashcards for ${userFlashcards.size} users.`);
    }
  } catch (err) {
    console.error('Error loading flashcards:', err.message);
  }
}

function recordQuizStats(chatId, exam, subject, score, total) {
  const existing = userStats.get(chatId) || {
    totalTests: 0, totalQuestions: 0, totalCorrect: 0, streak: 0,
    lastTestDate: null, byExam: {}
  };

  existing.totalTests += 1;
  existing.totalQuestions += total;
  existing.totalCorrect += score;

  // Streak tracking
  const today = new Date().toDateString();
  if (existing.lastTestDate === today) {
    // Same day, no streak change
  } else if (existing.lastTestDate === new Date(Date.now() - 86400000).toDateString()) {
    existing.streak = (existing.streak || 0) + 1; // Consecutive day
  } else {
    existing.streak = 1; // Streak reset
  }
  existing.lastTestDate = today;

  // By exam breakdown
  if (!existing.byExam[exam]) existing.byExam[exam] = { tests: 0, correct: 0, total: 0, bySubject: {} };
  existing.byExam[exam].tests += 1;
  existing.byExam[exam].correct += score;
  existing.byExam[exam].total += total;

  // By subject breakdown
  if (!existing.byExam[exam].bySubject[subject]) existing.byExam[exam].bySubject[subject] = { correct: 0, total: 0 };
  existing.byExam[exam].bySubject[subject].correct += score;
  existing.byExam[exam].bySubject[subject].total += total;

  userStats.set(chatId, existing);
  saveStats();
}

function formatStatsMessage(chatId) {
  const s = userStats.get(chatId);
  if (!s || s.totalTests === 0) {
    return '📊 <b>Your Performance Stats</b>\n\nNo tests taken yet. Take your first test to see your stats here!';
  }

  const overallAcc = s.totalQuestions > 0 ? Math.round((s.totalCorrect / s.totalQuestions) * 100) : 0;
  const streakEmoji = s.streak >= 7 ? '🔥' : s.streak >= 3 ? '⚡' : '📅';

  let msg = `📊 <b>Your Performance Dashboard</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🎯 <b>Total Tests Taken:</b> ${s.totalTests}\n`;
  msg += `✅ <b>Total Questions:</b> ${s.totalQuestions}\n`;
  msg += `🏆 <b>Overall Accuracy:</b> ${overallAcc}%\n`;
  msg += `${streakEmoji} <b>Current Streak:</b> ${s.streak || 0} day(s)\n\n`;

  msg += `📚 <b>Exam-wise Breakdown:</b>\n`;
  for (const [exam, ed] of Object.entries(s.byExam)) {
    const acc = ed.total > 0 ? Math.round((ed.correct / ed.total) * 100) : 0;
    msg += `\n<b>${escapeHTML(exam)}</b> — ${acc}% (${ed.tests} test${ed.tests !== 1 ? 's' : ''})\n`;

    // Show top 3 subjects
    const subjects = Object.entries(ed.bySubject)
      .map(([subj, d]) => ({ subj, acc: d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0, total: d.total }))
      .sort((a, b) => b.total - a.total).slice(0, 3);

    for (const { subj, acc: sAcc } of subjects) {
      const bar = sAcc >= 80 ? '🟢' : sAcc >= 50 ? '🟡' : '🔴';
      msg += `  ${bar} ${escapeHTML(subj)}: ${sAcc}%\n`;
    }
  }

  // Weak area tip
  let weakestSubj = null, weakestAcc = 101;
  for (const ed of Object.values(s.byExam)) {
    for (const [subj, d] of Object.entries(ed.bySubject)) {
      const a = d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0;
      if (a < weakestAcc) { weakestAcc = a; weakestSubj = subj; }
    }
  }
  if (weakestSubj) {
    msg += `\n💡 <b>Weak Area:</b> ${escapeHTML(weakestSubj)} (${weakestAcc}%) — Practice more!`;
  }


  return msg;
}

loadSchedules();
loadUsers();
loadStats();
loadBookmarks();
loadPinnedTokens();
loadTokenStats();
loadExamDates();
loadFlashcards();


// ==================== NOTION HELPERS ====================

/**
 * Create nested Notion structure: Exam -> Subject -> Topic -> Questions
 */
/**
 * Unified helper to get or create a pure Notion sub-page by title
 */
/**
 * Unified helper to get or create a pure Notion sub-page by title (Folder style)
 */
async function getOrCreateSubPage(parentId, pageTitle, iconEmoji = '📁') {
  const currentKey = (process.env.NOTION_API_KEY || '').trim();
  const rawParentId = (parentId || '').trim();

  try {
    // 1. First, search blocks (for when parent is a Page)
    const childrenRes = await axios.get(`https://api.notion.com/v1/blocks/${rawParentId}/children`, {
      headers: { 'Authorization': `Bearer ${currentKey}`, 'Notion-Version': '2022-06-28' }
    });

    let existingPage = childrenRes.data.results.find(
      b => b.type === 'child_page' &&
        b.child_page.title.toLowerCase().trim() === pageTitle.toLowerCase().trim()
    );
    if (existingPage) return existingPage.id;

    // 2. If not found, it might be that the parent is a Database (which doesn't show entries as children blocks)
    try {
      const dbQueryRes = await axios.post(`https://api.notion.com/v1/databases/${rawParentId}/query`, {
        filter: {
          or: [
            { property: 'title', title: { equals: pageTitle } },
            { property: 'Name', title: { equals: pageTitle } }
          ]
        }
      }, {
        headers: { 'Authorization': `Bearer ${currentKey}`, 'Notion-Version': '2022-06-28' }
      });

      if (dbQueryRes.data.results && dbQueryRes.data.results.length > 0) {
        return dbQueryRes.data.results[0].id;
      }

      // Secondary check for database case-insensitive (fetch all and find)
      const dbAllRes = await axios.post(`https://api.notion.com/v1/databases/${rawParentId}/query`, {}, {
        headers: { 'Authorization': `Bearer ${currentKey}`, 'Notion-Version': '2022-06-28' }
      });
      const foundInDb = dbAllRes.data.results.find(page => {
        const titleProp = page.properties.title || page.properties.Name || page.properties.Subject || page.properties.Topic;
        if (!titleProp || !titleProp.title || !titleProp.title[0]) return false;
        return titleProp.title[0].plain_text.toLowerCase().trim() === pageTitle.toLowerCase().trim();
      });
      if (foundInDb) return foundInDb.id;

    } catch (e) {
      // Ignore database query errors (e.g. if it's not a database)
    }

    // 3. Create new sub-page.
    const icon = iconEmoji.startsWith('http')
      ? { type: 'external', external: { url: iconEmoji } }
      : { type: 'emoji', emoji: iconEmoji };

    try {
      const response = await axios.post(`https://api.notion.com/v1/pages`, {
        parent: { type: 'page_id', page_id: rawParentId },
        icon: icon,
        properties: { title: { title: [{ text: { content: pageTitle } }] } }
      }, {
        headers: { 'Authorization': `Bearer ${currentKey}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }
      });
      return response.data.id;
    } catch (e) {
      // Fallback for Database-as-parent creation
      const dbFallback = await axios.post(`https://api.notion.com/v1/pages`, {
        parent: { database_id: rawParentId },
        icon: icon,
        properties: { 'Name': { title: [{ text: { content: pageTitle } }] } }
      }, {
        headers: { 'Authorization': `Bearer ${currentKey}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }
      });
      return dbFallback.data.id;
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    console.error(`Error with Page "${pageTitle}":`, errorMsg);
    throw new Error(`${pageTitle}: ${errorMsg}`);
  }
}

/**
 * Orchestrator to save all questions perfectly aligned in Notion hierarchy
 */
async function saveAllQuestionsToNotion(exam, subject, topic, questions, chatId) {
  let statusMsg = null;
  try {
    statusMsg = await bot.sendMessage(chatId, `💾 <b>Notion Vault Sync</b>\n━━━━━━━━━━━━━━━━━━━━\n⏳ <b>Initializing connection...</b>\n📂 <b>Path:</b> ${escapeHTML(exam)} ...`, { parse_mode: 'HTML' });

    // 1. Root -> Exam Folder (Official Icon)
    await bot.editMessageText(`💾 <b>Notion Vault Sync</b>\n━━━━━━━━━━━━━━━━━━━━\n📂 🔐 <b>Opening Exam Vault: ${escapeHTML(exam)}</b>\n📂 <b>Path:</b> ${escapeHTML(exam)} › ...`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => { });

    const examIcon = EXAM_ICONS[exam]?.url || '🏛️';
    const examPageId = await getOrCreateSubPage(NOTION_PARENT_DB, exam, examIcon);

    if (!examPageId) throw new Error('Exam folder creation failed');

    // 2. Exam -> Subject Folder (📚)
    await bot.editMessageText(`💾 <b>Notion Vault Sync</b>\n━━━━━━━━━━━━━━━━━━━━\n📚 📂 <b>Accessing Subject: ${escapeHTML(subject)}</b>\n📂 <b>Path:</b> ${escapeHTML(exam)} › ${escapeHTML(subject)} › ...`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => { });

    const subjectPageId = await getOrCreateSubPage(examPageId, subject, '📚');
    if (!subjectPageId) throw new Error('Subject folder creation failed');

    // 3. Subject -> Topic Folder/Page (📝)
    await bot.editMessageText(`💾 <b>Notion Vault Sync</b>\n━━━━━━━━━━━━━━━━━━━━\n📝 📂 <b>Preparing Topic: ${escapeHTML(topic)}</b>\n📂 <b>Path:</b> ${escapeHTML(exam)} › ${escapeHTML(subject)} › ${escapeHTML(topic)}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => { });

    const topicPageId = await getOrCreateSubPage(subjectPageId, topic, '📝');

    if (!topicPageId) throw new Error('Topic page creation failed');

    // 4. Count existing questions to maintain continuity (Paginated)
    let startIndex = 1;
    try {
      let existingQs = 0;
      let hasMore = true;
      let cursor = undefined;

      while (hasMore) {
        const blocksRes = await axios.get(`https://api.notion.com/v1/blocks/${topicPageId}/children`, {
          headers: { 'Authorization': `Bearer ${NOTION_KEY}`, 'Notion-Version': '2022-06-28' },
          params: { start_cursor: cursor }
        });

        existingQs += blocksRes.data.results.filter(b => {
          if (b.type === 'heading_3') return true;
          if (b.type === 'paragraph') {
            const text = b.paragraph?.rich_text?.[0]?.text?.content || '';
            return text.startsWith('Question ');
          }
          return false;
        }).length;
        hasMore = blocksRes.data.has_more;
        cursor = blocksRes.data.next_cursor;
        if (existingQs > 500) break; // Safety limit
      }
      startIndex = existingQs + 1;
    } catch (e) {
      console.log('Error counting existing questions, starting from 1');
    }

    // 5. Save Questions (Handling sets/contexts)
    let lastContext = null;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const pct = Math.round(((i + 1) / questions.length) * 100);

      if (i % 2 === 0 || i === questions.length - 1) { // Throttled UI update
        await bot.editMessageText(`💾 <b>Notion Vault Sync</b>\n━━━━━━━━━━━━━━━━━━━━\n✍️ <b>Writing Question ${i + 1}/${questions.length}</b>\n${getGlowProgressBar(pct)}\n\n📂 <b>Path:</b> ${escapeHTML(exam)} › ${escapeHTML(subject)} › ${escapeHTML(topic)}`, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: 'HTML'
        }).catch(() => { });
      }


      // If there's a new common context, save it as a divider/header
      if (q.context && q.context.trim() !== "" && q.context !== lastContext) {
        await saveContextBlock(topicPageId, q.context);
        lastContext = q.context;
      }

      await saveQuestionToNotion(topicPageId, q, startIndex + i);
    }

    const notionUrl = `https://www.notion.so/${topicPageId.replace(/-/g, '')}`;
    await bot.editMessageText(`✅ <b>Sync Complete!</b>\n━━━━━━━━━━━━━━━━━━━━\n🏆 <b>${questions.length} Questions Indexed</b>\n📂 <b>Path:</b> ${escapeHTML(exam)} › ${escapeHTML(subject)} › ${escapeHTML(topic)}\n\n🔗 <a href="${notionUrl}">View Topic in Notion</a>`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }).catch(() => {

      bot.sendMessage(chatId, `✅ <b>Sync Complete!</b>\n\n🔗 <a href="${notionUrl}">View Topic in Notion</a>`, { parse_mode: 'HTML' });
    });

    console.log(`✅ Progress: All questions saved to Notion page ${topicPageId}`);
  } catch (error) {
    console.error('Notion Hierarchy Error:', error.message);
    bot.sendMessage(chatId, `⚠️ Generate succeeded, but could not complete Notion save: ${error.message}`);
  }
}

async function saveContextBlock(topicPageId, context) {
  try {
    await axios.patch(`https://api.notion.com/v1/blocks/${topicPageId}/children`, {
      children: [
        {
          object: 'block',
          callout: {
            rich_text: [{ text: { content: `📖 COMMON CONTEXT:\n${context}` } }],
            icon: { emoji: '📖' },
            color: 'blue_background'
          }
        }
      ]
    }, {
      headers: { 'Authorization': `Bearer ${NOTION_KEY}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('Error saving context block:', e.message);
  }
}

/**
 * Save question blocks directly inside the Topic page
 */
async function saveQuestionToNotion(topicPageId, question, questionIndex) {
  const currentKey = NOTION_KEY;

  try {
    await axios.patch(
      `https://api.notion.com/v1/blocks/${topicPageId}/children`,
      {
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: `Question ${questionIndex}: ${question.question}` },
                  annotations: { bold: true }
                }
              ]
            }
          },
          {
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{ type: 'text', text: { content: `A) ${question.optionA}` } }]
            }
          },
          {
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{ type: 'text', text: { content: `B) ${question.optionB}` } }]
            }
          },
          {
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{ type: 'text', text: { content: `C) ${question.optionC}` } }]
            }
          },
          {
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{ type: 'text', text: { content: `D) ${question.optionD}` } }]
            }
          },
          {
            object: 'block',
            type: 'toggle',
            toggle: {
              rich_text: [{ type: 'text', text: { content: `💡 Reveal Answer & Explanation` } }],
              children: [
                {
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [
                      { type: 'text', text: { content: `Correct Answer: ` }, annotations: { bold: true, color: 'green' } },
                      { type: 'text', text: { content: `${question.correctAnswer}\n\n` } },
                      { type: 'text', text: { content: `📖 Explanation:\n` }, annotations: { bold: true } },
                      { type: 'text', text: { content: question.explanation || "No explanation provided" } }
                    ]
                  }
                }
              ]
            }
          },
          {
            object: 'block',
            type: 'divider',
            divider: {}
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${currentKey}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Error saving question blocks:', JSON.stringify(error.response?.data || error.message));
  }
}



// ==================== AI QUESTION GENERATION ====================

function isBankSetBasedHelper(exam, topic) {
  if (exam !== 'Bank' || !topic) return false;
  const t = topic.toLowerCase();

  // Strict matching exactly against the requested Set-type topics:
  return (
    t === 'puzzles' || t === 'puzzle' ||
    t.includes('data interpretation') ||
    t.includes('data sufficiency') ||
    t.includes('linear seating arrangement') ||
    t.includes('circular seating arrangement') ||
    t.includes('square seating arrangement') ||
    t.includes('triangular seating arrangement') ||
    t.includes('scheduling puzzle') ||
    t.includes('floor - flat puzzle') ||
    t.includes('ranking - order puzzle') ||
    t.includes('blood relation puzzle') ||
    t.includes('age-based puzzle') ||
    t.includes('direction sense') ||
    t.includes('caselet di')
  );
}

function getSystemPrompt(exam, subject, topic, count, pastedText = null, seed = "") {
  const isCurrentAffairs = (subject || '').toLowerCase().includes('current affairs');
  const yearRange = isCurrentAffairs ? '2024 to 2025' : '2000 to 2025';
  const isBankSetBased = isBankSetBasedHelper(exam, topic);

  const setBasedInstruction = isBankSetBased ? `
Every block of 5 questions MUST share the EXACT SAME context string.
For ${count} questions, generate exactly ${Math.ceil(count / 5)} distinct contexts.` : '';

  const sourceInstruction = pastedText ? `
CRITICAL: GENERATE QUESTIONS ONLY FROM THIS PROVIDED SOURCE TEXT:
--- START SOURCE TEXT ---
${pastedText}
--- END SOURCE TEXT ---

Your goal is to extract key facts, concepts, and data from the provided text and turn them into exam-standard questions. DO NOT use outside knowledge if it contradicts the text.` : '';

  const varietyInstruction = `
ANTI-REPETITION & UNIQUENESS RULES:
- RANDOM SEED ID: [${seed}]
- AVOID "common" or "obvious" questions that are frequently asked in mocks.
- Focus on obscure details, deep conceptual links, and diverse sub-topics within ${topic}.
- Change the focus area with each call. If you previously asked about names, now ask about dates, significance, or impact.
- Every question must feel fresh and unique. NO REPETITION of concepts from common question banks.`;

  // ===== QUESTION TYPE COUNTS (For Non-Bank Exams) =====
  let directCount = 0, yearCount = 0, statementCount = 0, assertionCount = 0, matchCount = 0, chronoCount = 0, dataCount = 0;
  
  if (exam !== 'Bank') {
    directCount = Math.max(1, Math.round(count * 0.20)); // ~20% Direct
    yearCount = Math.max(1, Math.round(count * 0.15)); // ~15% Year
    statementCount = Math.max(1, Math.round(count * 0.15)); // ~15% Statement
    assertionCount = Math.max(1, Math.round(count * 0.15)); // ~15% Assertion-Reason
    matchCount = Math.max(1, Math.round(count * 0.15)); // ~15% Match-the-Following
    chronoCount = Math.max(1, Math.round(count * 0.10)); // ~10% Chronological
    dataCount = Math.max(1, Math.round(count * 0.10)); // ~10% Data-Precision
  }

  // ===== EXAM PAPER REFERENCE ANCHORS =====
  const pyqSources = {
    'SSC': 'SSC CGL (2010-2025), SSC CHSL (2012-2025), SSC MTS (2014-2025), SSC GD (2018-2025)',
    'RRB': 'RRB NTPC (2016-2025), RRB Group D (2018-2025), RRB ALP (2014-2025), RRB JE (2015-2025)',
    'TNPSC': 'TNPSC Group 1 (2000-2025), Group 2 (2000-2025), Group 2A (2000-2025), Group 4 (2000-2025), VAO (2006-2025)',
    'Bank': 'IBPS PO (2011-2025), IBPS Clerk (2011-2025), SBI PO (2010-2025), SBI Clerk (2010-2025)',
    'JE': 'RRB JE (2015-2025), SSC JE (2013-2025), GATE ME (2010-2025), UPSC ESE (2005-2025), PSU Technical Papers (2000-2025)'
  }[exam] || 'Indian Govt Competitive Exam papers (2000-2025)';

  const examContext = {
    'SSC': 'SSC CGL, SSC CHSL, SSC MTS, SSC GD Constable — Tier 1 & Tier 2 patterns (2000-2025)',
    'RRB': 'RRB NTPC, RRB Group D, RRB ALP, RRB JE — CBT 1 & CBT 2 patterns (2000-2025)',
    'TNPSC': 'TNPSC Group 1, Group 2, Group 2A, Group 4, VAO — Prelims & Mains patterns (2000-2025)',
    'Bank': 'IBPS PO, IBPS Clerk, SBI PO, SBI Clerk — Prelims & Mains (2000-2025)',
    'JE': 'RRB JE, SSC JE, GATE ME, UPSC ESE (Mechanical/Production Engineering) — Technical Paper patterns (2000-2025)'
  }[exam] || 'Indian Competitive Government Exams (2000-2025)';

  const examSpecificRules = {
    'TNPSC': `
TNPSC-SPECIFIC MANDATORY RULES:
- MUST include questions on: Tamil Sangam Literature, Thirukkural, Tamil Nadu history, Tamil culture & festivals, Tamil leaders (Periyar, Ambedkar's impact in TN, MGR, Kamarajar).
- MUST include: TNPSC standard GK — state symbols, rivers in TN, geography of TN.
- PYQs: Source from actual TNPSC Group 1/2/4 papers from 2000-2025.
- Language: Simple English; no complex vocabulary.`,
    'SSC': `
SSC-SPECIFIC MANDATORY RULES:
- MUST include questions from: NCERT 6th-12th (History, Geography, Polity, Economics, Science).
- MUST include: Indian Polity (Constitution, Parliament, Judiciary), Indian History (Ancient/Medieval/Modern), Geography (physical & political), Science (Physics/Chemistry/Biology basics), Economy.
- PYQs: Source from actual SSC CGL/CHSL/MTS papers from 2010-2025.
- Difficulty: SSC Tier-1 standard — moderate difficulty, not too easy, not UPSC-level obscure.`,
    'RRB': `
RRB-SPECIFIC MANDATORY RULES:
- MUST include: Railway-specific GK (history of Indian Railways, types of trains, zones, railway ministers), Science basics (Physics laws, chemical formulas, biology).
- MUST include: Current Affairs related to Railways, Indian infrastructure, science & tech.
- PYQs: Source from actual RRB NTPC/Group D/ALP papers from 2016-2025.
- Language: RRB Tier-1 CBT standard — straightforward language, factual.`,
    'Bank': `
BANK-SPECIFIC MANDATORY RULES:
- MUST include: Banking Awareness, RBI policies, financial terms, Indian economy, government banking schemes.
- PYQs: Source from actual IBPS PO/Clerk, SBI PO/Clerk papers from 2011-2025.`,
    'JE': `
JE (JUNIOR ENGINEER) — SPECIFIC MANDATORY RULES:
- MUST generate TECHNICAL engineering questions suitable for RRB JE, SSC JE, GATE ME, and UPSC ESE (Mechanical) exams.
- MUST include: Formulae-based numerical problems, conceptual theory questions, and applied engineering scenarios.
- Subjects covered: Fluid Mechanics, Thermodynamics, Heat Transfer, Engineering Mechanics, Strength of Materials, Theory of Machines, Design of Machine Elements, Production Engineering, Refrigeration & AC, Power Plant Engineering, IC Engines, Industrial Engineering, Materials Science, CAD/CAM/CIM/FEA.
- PYQs: Source from actual RRB JE (2015-2025) and SSC JE (2013-2025) papers. Tag each PYQ with source + year.
- Numerical questions MUST include correct formula, substitute values, and final answer with units.
- Options for numerical Qs must be realistic close-range values (e.g., differ by 5-15%).
- Difficulty: JE-standard — formula application, unit analysis, and conceptual depth required.`
  }[exam] || '';

  const prompt = `You are an ELITE Senior Question Paper Setter with 25+ years of experience creating official question papers for ${examContext}.

Your ONLY task: Generate EXACTLY ${count} questions for the REAL ${exam} EXAMINATION — questions that are INDISTINGUISHABLE from actual official ${exam} papers from ${yearRange}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOPIC: ${topic} | SUBJECT: ${subject} | EXAM: ${exam}
PYQ SOURCES TO USE: ${pyqSources}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  let typeInstructions = '';
  if (exam !== 'Bank') {
    typeInstructions = `
╔══════════════════════════════════════════╗
║  MANDATORY 7 QUESTION TYPES — ALL MUST  ║
║  APPEAR. MISSING ANY TYPE = FAILURE.    ║
╚══════════════════════════════════════════╝

【TYPE 1 — DIRECT & FACT-BASED】 EXACTLY ~${directCount} questions
→ Single-line factual MCQ. All 4 options must be highly plausible close-variants.
Example: "How many members are nominated by the President to the Rajya Sabha?"
A) 10   B) 12 ✓   C) 14   D) 16

【TYPE 2 — YEAR & DATE-BASED】 EXACTLY ~${yearCount} questions
→ Ask WHEN an important event occurred. All 4 year-options must be within 3–5 years of each other.
Example: "In which year was the Indian Constitution adopted?"
A) 1948   B) 1949 ✓   C) 1950   D) 1951

【TYPE 3 — STATEMENT TYPE (CBI/UPSC/SSC Style)】 EXACTLY ~${statementCount} questions
→ Give exactly 3 statements. Ask which are correct.
→ Options MUST follow this pattern: "1 only / 2 and 3 only / 1 and 3 only / All of the above"
Format:
"Consider the following statements about [topic]:
1. [Statement]
2. [Statement]  
3. [Statement]
Which is/are CORRECT?"
A) 1 only   B) 2 and 3 only   C) 1 and 3 only   D) All of the above

【TYPE 4 — ASSERTION & REASON】 EXACTLY ~${assertionCount} questions
→ Options MUST ALWAYS be EXACTLY these 4: A) Both A & R true, R is correct explanation; B) Both A & R true, R not correct explanation; C) A true, R false; D) A false, R true.
Format:
"Assertion (A): [Factual assertion]
Reason (R): [Reasoning]"

【TYPE 5 — MATCH THE FOLLOWING】 EXACTLY ~${matchCount} questions
→ List I: 4 items (A-D). List II: 4 items (1-4).
Format:
"Match List I with List II:
[List rows]
Select correct match: A) A-2, B-1, C-4, D-3 ..."

【TYPE 6 — CHRONOLOGICAL ORDER】 EXACTLY ~${chronoCount} questions
→ List 4 events. Arrange oldest to newest.
Format: "Arrange in CHRONOLOGICAL order: 1. [A] 2. [B] 3. [C] 4. [D]"

→ Questions with exact numerical/statistical data from official sources.
`;
  } else {
    // Bank-specific instructions
    if (subject === 'Quants') {
      typeInstructions = `
╔══════════════════════════════════════════╗
║  ARITHMETIC TYPE QUESTIONS (BANK QUANTS) ║
╚══════════════════════════════════════════╝
For Bank Quants, generate ONLY "Arithmetic Type" questions.
- Word Problems: Questions must be scenarios based on ${topic}.
- Calculation Intensive: Require 1-3 steps of calculation.
- Logical Application: Not just formulas, but applying concepts to situations.
- Realistic Data: Use values that appear in IBPS/SBI PO/Clerk papers.
- Tag as "Arithmetic".

Format:
"A person buys [x] at [y]... [Scenario description]. What is the [final value]?"
A) [Value]  B) [Value]  C) [Value]  D) [Value]
`;
    } else {
      typeInstructions = `
╔══════════════════════════════════════════╗
║  BANK STANDARD EXAM QUESTIONS          ║
╚══════════════════════════════════════════╝
For this Bank subject (${subject}), generate questions strictly following the latest IBPS/SBI pattern.
- CRITICAL: NO Statement-type questions.
- CRITICAL: NO Assertion-Reason questions.
- CRITICAL: NO Match the Following questions.
- CRITICAL: NO Chronological Order questions.
- Focus strictly on: High-speed decision making, conceptual clarity, and bank-specific pattern recognition.
- For Reasoning: Use complex conditions and puzzles.
- For English: Use modern bank context exam patterns.
`;
    }
  }

  const finalPrompt = prompt + typeInstructions + `

${setBasedInstruction}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTENT DISTRIBUTION (ALL MANDATORY):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 40% PYQs (2000-2025): REAL questions from actual ${exam} papers listed above.
  Tag each PYQ with exact source: exam name + year (e.g., "SSC CGL 2019 PYQ").
• 30% HIGH-PROBABILITY MCQs: Most-repeated concepts from ${exam} pattern. Tag as "High Probability".
• 30% FUTURE EXPECTED: Prediction based on 2025 trends. Tag as "Expected 2025-2026".

${exam !== 'Bank' ? `DIFFICULTY PROGRESSION (STRICT ORDER):
• Questions 1 to ${Math.round(count * 0.2)}: EASY — Types 1 & 2 (Direct facts, Year questions)
• Questions ${Math.round(count * 0.2) + 1} to ${Math.round(count * 0.6)}: MODERATE — Types 3, 5, 7 (Statement, Match, Data)
• Questions ${Math.round(count * 0.6) + 1} to ${count}: HARD — Types 4 & 6 (Assertion-Reason, Chronological)` 
: `DIFFICULTY PROGRESSION:
- Mix of Easy, Moderate, and Hard questions throughout the set to simulate a real banking exam experience.`}

${examSpecificRules}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUALITY STANDARDS (NON-NEGOTIABLE):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✗ NO trivial or kindergarten-level questions.
✗ NO obviously wrong distractors (all 4 options must mislead an unprepared candidate).
✗ NO repeated questions or duplicate concepts.
✗ NO vague or ambiguous question stems.
✓ Each explanation must say WHY correct answer is right AND WHY each wrong option is wrong.
${isCurrentAffairs ? '✓ CURRENT AFFAIRS ONLY: Strictly 2024 and 2025 events. Include appointments, awards, summits, schemes, reports.' : ''}

${exam !== 'Bank' ? `SELF-VERIFICATION (before outputting JSON, check these):
□ Have I included at least ${directCount} Direct questions?
□ Have I included at least ${yearCount} Year/Date questions?
□ Have I included at least ${statementCount} Statement questions (with 3 statements each)?
□ Have I included at least ${assertionCount} Assertion-Reason questions (with standard A/B/C/D)?
□ Have I included at least ${matchCount} Match-the-Following questions (List I & II, 4 pairs)?
□ Have I included at least ${chronoCount} Chronological Order questions (exactly 4 events)?
□ Have I included at least ${dataCount} Data/Precision questions (with verifiable stats)?
If any box is unchecked — REGENERATE that type before outputting.` : `SELF-VERIFICATION:
□ Are all questions strictly based on the ${exam} pattern for ${subject}?
${subject === 'Quants' ? '□ Are all questions Arithmetic Type word problems?' : ''}`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — VALID JSON ONLY. NO MARKDOWN. START WITH { IMMEDIATELY.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "questions": [
    {
${isBankSetBased ? '      "context": "Common passage/context (REQUIRED for every 5 questions in Bank set-based topics)",\n' : ''}      "type": "${exam === 'Bank' ? (subject === 'Quants' ? 'Arithmetic' : 'Bank Standard') : 'Direct|Year|Statement|Assertion-Reason|Match|Chronological|Data'}",
      "question": "Full question text formatted exactly as per the type rules above",
      "optionA": "Plausible option A",
      "optionB": "Plausible option B",
      "optionC": "Plausible option C",
      "optionD": "Plausible option D",
      "correctAnswer": "A",
      "explanation": "✅ Correct: [why this is right]. ❌ A/B/C/D wrong: [brief reason for each wrong option]",
      "difficulty": "Easy|Moderate|Hard",
      "trick": "Memory trick or mnemonic (leave empty string if none)",
      "pyqTag": "SSC CGL 2019 PYQ | TNPSC Group 2 2022 PYQ | High Probability | Expected 2025-2026"
    }
  ]
}

${sourceInstruction}

${varietyInstruction}

FINAL REMINDER: Every single question must be something that could appear in the actual ${exam} official paper. No shortcuts. No filler. Highest exam standard only.`;

  return finalPrompt;
}

function getUserPrompt(exam, subject, topic, count, pastedText = null, seed = "") {
  const isCurrentAffairs = (subject || '').toLowerCase().includes('current affairs');
  const yearRange = isCurrentAffairs ? '2024 to 2025' : '2000 to 2025';
  const isBankSetBased = isBankSetBasedHelper(exam, topic);

  const varietyInst = `
DIVERSITY REQUIREMENT:
The seed for this generation is ${seed}. Use this to explore a UNIQUE set of facts within ${topic}. Avoid repeating typical questions. Focus on the nuances.`;

  let typeSpecificPrompt = '';
  if (exam !== 'Bank') {
    const d = Math.max(1, Math.round(count * 0.20));
    const y = Math.max(1, Math.round(count * 0.15));
    const s = Math.max(1, Math.round(count * 0.15));
    const a = Math.max(1, Math.round(count * 0.15));
    const m = Math.max(1, Math.round(count * 0.15));
    const c = Math.max(1, Math.round(count * 0.10));
    const dt = Math.max(1, Math.round(count * 0.10));

    typeSpecificPrompt = `
ALL 7 QUESTION TYPES ARE MANDATORY — YOU MUST INCLUDE EVERY TYPE:
1️⃣ DIRECT & FACT-BASED ............. ~${d} questions  [EASY]
2️⃣ YEAR & DATE-BASED ............... ~${y} questions  [EASY]
3️⃣ STATEMENT TYPE .................. ~${s} questions  [MODERATE]  
4️⃣ ASSERTION & REASON .............. ~${a} questions  [HARD]
5️⃣ MATCH THE FOLLOWING ............. ~${m} questions  [MODERATE]
6️⃣ CHRONOLOGICAL ORDER ............. ~${c} questions  [HARD]
7️⃣ DATA & PRECISION-BASED .......... ~${dt} questions [MODERATE]

CRITICAL REQUIREMENTS:
• Questions 1-${Math.round(count * 0.2)}: EASY (Direct + Year types)
• Questions ${Math.round(count * 0.2) + 1}-${Math.round(count * 0.6)}: MODERATE (Statement + Match + Data types)
• Questions ${Math.round(count * 0.6) + 1}-${count}: HARD (Assertion-Reason + Chronological types)`;
  } else {
    // Bank specific
    if (subject === 'Quants') {
      typeSpecificPrompt = `
ARITHMETIC TYPE MANDATORY (BANK QUANTS):
• Every single question MUST be an "Arithmetic Type" word problem scenario.
• DO NOT include Statement-type, Assertion-Reason, Match the Following, or Chronological questions.
• Focus on scenarios, logical application, and numerical values typical of IBPS/SBI PO/Clerk exams.
• Tag each question type as "Arithmetic".`;
    } else {
      typeSpecificPrompt = `
BANK EXAM STANDARD:
• Follow the IBPS/SBI pattern for ${subject}.
• STRICTLY EXCLUDE: Statement-type, Assertion-Reason, Match the Following, and Chronological Order questions.
• Tag as "Bank Standard".`;
    }
  }

  let prompt = `I need EXACTLY ${count} REAL ${exam} EXAM STANDARD questions on:
Topic: "${topic}" | Subject: ${subject} | Year Range: ${yearRange}

${pastedText ? `ONLY USE THIS SOURCE TEXT TO GENERATE QUESTIONS:\n\n${pastedText}` : ''}

${varietyInst}

${typeSpecificPrompt}

CRITICAL REQUIREMENTS:
• 40% must be REAL PYQs from actual ${exam} papers (${yearRange}) — tag with paper name + year
• All 4 options must each be plausible — no obviously wrong distractors
• Explanation must state WHY correct is right AND WHY each wrong option is incorrect
• RETURN EXACTLY ${count} QUESTIONS — not fewer, not more`;

  if (isBankSetBased) {
    prompt += `\n\n🏦 BANK SET-BASED RULE: Group questions in sets of 5 with 1 shared context per set. Total contexts needed: ${Math.ceil(count / 5)}.`;
  }

  return prompt;
}


/**
 * Generate questions using Gemini API (with multiple model version fallbacks)
 */
async function generateQuestionsWithGemini(topic, exam, subject, count = 10, pastedText = null, customSeed = null) {
  const seed = customSeed || (Date.now().toString(36) + Math.random().toString(36).substring(2, 7));
  
  // Comprehensive list of available Gemini models
  const allModels = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro'
  ];

  // Prioritize the last working model if we have one
  const modelsToTry = LAST_WORKING_GEMINI_MODEL 
    ? [LAST_WORKING_GEMINI_MODEL, ...allModels.filter(m => m !== LAST_WORKING_GEMINI_MODEL)]
    : allModels;

  for (const model of modelsToTry) {
    try {
      console.log(`Trying Gemini model: ${model}...`);
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          systemInstruction: { parts: [{ text: getSystemPrompt(exam, subject, topic, count, pastedText, seed) }] },
          contents: [{ role: 'user', parts: [{ text: getUserPrompt(exam, subject, topic, count, pastedText, seed) }] }],
          generationConfig: { 
            responseMimeType: 'application/json',
            temperature: 0.7,
            topP: 0.95
          }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const data = response.data;
      if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        const text = data.candidates[0].content.parts[0].text;
        const parsed = JSON.parse(text);
        if (parsed.questions && parsed.questions.length > 0) {
          console.log(`✅ Success with Gemini model: ${model}`);
          LAST_WORKING_GEMINI_MODEL = model; // Remember this model for next time

          const usage = data.usageMetadata || {};
          const p = usage.promptTokenCount || 0;
          const c = usage.candidatesTokenCount || 0;
          const t = usage.totalTokenCount || (p + c);
          const tokenUsage = { promptTokens: p, completionTokens: c, totalTokens: t };

          recordTokenUsage(`Gemini (${model})`, tokenUsage);
          return { questions: parsed.questions, tokenUsage };
        }
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      console.warn(`⚠️ Model ${model} failed: ${errorMsg}`);
      
      // If we used the LAST_WORKING_GEMINI_MODEL and it failed, reset it
      if (model === LAST_WORKING_GEMINI_MODEL) {
        LAST_WORKING_GEMINI_MODEL = null;
      }
    }
  }

  return null; // All Gemini models failed
}

/**
 * Generate questions using ChatGPT API (with multiple model version fallbacks)
 */
async function generateQuestionsWithChatGPT(topic, exam, subject, count = 10, pastedText = null, customSeed = null) {
  const seed = customSeed || (Date.now().toString(36) + Math.random().toString(36).substring(2, 7));
  const models = [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4-turbo',
    'gpt-3.5-turbo'
  ];

  for (const model of models) {
    try {
      console.log(`Trying ChatGPT model: ${model}...`);
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: getSystemPrompt(exam, subject, topic, count, pastedText, seed) },
            { role: 'user', content: getUserPrompt(exam, subject, topic, count, pastedText, seed) }
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          }
        }
      );

      const data = response.data;
      if (data.choices && data.choices[0] && data.choices[0].message) {
        const text = data.choices[0].message.content;
        const parsed = JSON.parse(text);
        if (parsed.questions && parsed.questions.length > 0) {
          console.log(`✅ Success with ChatGPT model: ${model}`);

          const usage = data.usage || {};
          const p = usage.prompt_tokens || 0;
          const c = usage.completion_tokens || 0;
          const t = usage.total_tokens || (p + c);
          const tokenUsage = { promptTokens: p, completionTokens: c, totalTokens: t };

          recordTokenUsage(`ChatGPT (${model})`, tokenUsage);
          return { questions: parsed.questions, modelUsed: `ChatGPT (${model})`, tokenUsage };
        }
      }
    } catch (error) {
      console.warn(`⚠️ ChatGPT model ${model} failed or unavailable: ${error.message}`);
    }
  }

  return null;
}

/**
 * Generate questions with fallback logic
 */
async function generateQuestionsWithGroq(topic, exam, subject, count = 10, pastedText = null, customSeed = null) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;
  const seed = customSeed || Date.now().toString(36);
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'mixtral-8x7b-32768'];
  for (const model of models) {
    try {
      console.log(`Trying Groq model: ${model}...`);
      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: getSystemPrompt(exam, subject, topic, count, pastedText, seed) },
          { role: 'user', content: getUserPrompt(exam, subject, topic, count, pastedText, seed) }
        ]
      }, { headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 60000 });
      const text = response.data.choices[0].message.content;
      const parsed = JSON.parse(text);
      if (parsed.questions && parsed.questions.length > 0) {
        console.log(`✅ Success with Groq model: ${model}`);

        const usage = response.data.usage || {};
        const p = usage.prompt_tokens || 0;
        const c = usage.completion_tokens || 0;
        const t = usage.total_tokens || (p + c);
        const tokenUsage = { promptTokens: p, completionTokens: c, totalTokens: t };

        recordTokenUsage(`Groq (${model})`, tokenUsage);
        return { questions: parsed.questions, modelUsed: `Groq (${model})`, tokenUsage };
      }
    } catch (error) {
      console.warn(`⚠️ Groq model ${model} failed: ${error.response?.data?.error?.message || error.message}`);
    }
  }
  return null;
}

/**
 * Generate a single set/batch of questions (up to count, default 5) using AI model fallbacks
 */
async function generateSingleSetQuestions(topic, exam, subject, count = 5, pastedText = null, batchIndex = 0) {
  const seed = Date.now().toString(36) + `_b${batchIndex}_` + Math.random().toString(36).substring(2, 7);

  console.log(`[Set ${batchIndex + 1}] Attempting Gemini AI for ${count} question(s)...`);
  let geminiResult = await generateQuestionsWithGemini(topic, exam, subject, count, pastedText, seed);
  if (geminiResult && geminiResult.questions && geminiResult.questions.length > 0) {
    console.log(`[Set ${batchIndex + 1}] ✅ Gemini successful.`);
    return {
      questions: geminiResult.questions,
      modelUsed: `Gemini (${LAST_WORKING_GEMINI_MODEL || 'auto'})`,
      tokenUsage: geminiResult.tokenUsage
    };
  }

  console.log(`[Set ${batchIndex + 1}] ⚠️ Gemini failed. Falling back to Groq...`);
  const groqResult = await generateQuestionsWithGroq(topic, exam, subject, count, pastedText, seed);
  if (groqResult && groqResult.questions && groqResult.questions.length > 0) {
    console.log(`[Set ${batchIndex + 1}] ✅ Groq successful.`);
    return groqResult;
  }

  console.log(`[Set ${batchIndex + 1}] ⚠️ Groq failed. Falling back to ChatGPT...`);
  const chatGptResult = await generateQuestionsWithChatGPT(topic, exam, subject, count, pastedText, seed);
  if (chatGptResult && chatGptResult.questions && chatGptResult.questions.length > 0) {
    console.log(`[Set ${batchIndex + 1}] ✅ ChatGPT successful.`);
    return chatGptResult;
  }

  console.log(`[Set ${batchIndex + 1}] ❌ All AI models failed for this set.`);
  return null;
}

/**
 * Set-by-set batch generation to prevent AI timeouts/truncation when users request large question counts.
 * Breaks total requested count into 5-question sets and combines them seamlessly.
 */
async function generateQuestions(topic, exam, subject, count = 10, pastedText = null, onProgress = null, chatId = null) {
  const BATCH_SIZE = 5;
  const totalBatches = Math.ceil(count / BATCH_SIZE);

  let allQuestions = [];
  let combinedTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let modelsUsedSet = new Set();
  let remaining = count;

  console.log(`🚀 Starting set-by-set generation for total ${count} question(s) in ${totalBatches} set(s)...`);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    // Check for user cancellation before starting batch
    if (chatId && topicInput.get(chatId)?.cancelled) {
      console.log(`🛑 Generation cancelled by user ${chatId} before set ${batchIndex + 1}`);
      return null;
    }

    const currentBatchCount = Math.min(BATCH_SIZE, remaining);

    if (onProgress) {
      onProgress(allQuestions.length, count, batchIndex + 1, totalBatches);
    }

    const batchResult = await generateSingleSetQuestions(topic, exam, subject, currentBatchCount, pastedText, batchIndex);

    // Check cancellation again right after API call completes
    if (chatId && topicInput.get(chatId)?.cancelled) {
      console.log(`🛑 Generation cancelled by user ${chatId} during set ${batchIndex + 1}`);
      return null;
    }

    if (batchResult && batchResult.questions && batchResult.questions.length > 0) {
      allQuestions.push(...batchResult.questions);
      remaining -= batchResult.questions.length;

      if (batchResult.modelUsed) {
        modelsUsedSet.add(batchResult.modelUsed);
      }
      if (batchResult.tokenUsage) {
        combinedTokenUsage.promptTokens += (batchResult.tokenUsage.promptTokens || 0);
        combinedTokenUsage.completionTokens += (batchResult.tokenUsage.completionTokens || 0);
        combinedTokenUsage.totalTokens += (batchResult.tokenUsage.totalTokens || 0);
      }

      if (onProgress) {
        onProgress(allQuestions.length, count, batchIndex + 1, totalBatches);
      }
    } else {
      console.warn(`⚠️ Set ${batchIndex + 1}/${totalBatches} returned no questions.`);
      if (allQuestions.length === 0) {
        return null;
      }
      // Return what we generated so far if at least one set succeeded
      break;
    }
  }

  if (allQuestions.length === 0) {
    console.log('❌ All AI models failed across all sets.');
    return null;
  }

  const modelUsed = Array.from(modelsUsedSet).join(', ') || 'AI Assistant';

  return {
    questions: allQuestions.slice(0, count),
    modelUsed,
    tokenUsage: combinedTokenUsage
  };
}

/**
 * Unified helper to generate questions with a glowing progress animation
 */
function getGlowProgressBar(percent) {
  const totalSteps = 12;
  const filledSteps = Math.min(Math.round((percent / 100) * totalSteps), totalSteps);
  const emptySteps = totalSteps - filledSteps;

  // Ethereal "Glow" design: Core (█) with a light Aura (░) and trailing sparks
  const core = '█'.repeat(filledSteps);
  const aura = '░'.repeat(emptySteps);
  const spark = (percent > 0 && percent < 100) ? '✨' : (percent === 100 ? '🌟' : '');

  return `<b>⟨ ${core}${spark}${aura} ⟩  ${percent}%</b>`;
}

async function generateQuestionsWithAnimation(chatId, topic, exam, subject, count, pastedText = null) {
  // Ensure we have a cancellation entry
  if (!topicInput.has(chatId)) {
    topicInput.set(chatId, { cancelled: false, topic });
  } else {
    topicInput.get(chatId).cancelled = false;
  }

  let progressPercent = 0;
  let statusDetail = 'Manifesting your test path...';
  const totalBatches = Math.ceil(count / 5);

  const statusMsg = await bot.sendMessage(
    chatId,
    `✨ <b>ExamVault Luminance</b>\n━━━━━━━━━━━━━━━━━━━━\n🌟 <b>${statusDetail}</b>\n\n${getGlowProgressBar(0)}\n\n<i>Topic: ${topic} | Target: ${count} Questions (${totalBatches} Set${totalBatches > 1 ? 's' : ''})</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: getCancelKeyboard()
    }
  );

  const updateUI = async (completedQs, totalQs, bNum, bTotal) => {
    if (topicInput.get(chatId)?.cancelled) return;
    const percent = Math.min(99, Math.round((completedQs / totalQs) * 100));
    progressPercent = percent;
    statusDetail = `Generating Set ${bNum}/${bTotal} (${completedQs}/${totalQs} questions)...`;
    try {
      await bot.editMessageText(
        `✨ <b>ExamVault Luminance</b>\n━━━━━━━━━━━━━━━━━━━━\n🌟 <b>${statusDetail}</b>\n\n${getGlowProgressBar(percent)}\n\n<i>Topic: ${topic} | Target: ${totalQs} Questions</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: 'HTML',
          reply_markup: getCancelKeyboard()
        }
      );
    } catch (e) { }
  };

  // Start "Animation" interval for visual background updates
  const animInterval = setInterval(async () => {
    if (topicInput.get(chatId)?.cancelled) {
      clearInterval(animInterval);
      return;
    }

    if (progressPercent < 90) {
      progressPercent = Math.min(90, progressPercent + 2);
      try {
        await bot.editMessageText(
          `✨ <b>ExamVault Luminance</b>\n━━━━━━━━━━━━━━━━━━━━\n🌟 <b>${statusDetail}</b>\n\n${getGlowProgressBar(progressPercent)}\n\n<i>Topic: ${topic} | Target: ${count} Questions</i>`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'HTML',
            reply_markup: getCancelKeyboard()
          }
        );
      } catch (e) { }
    }
  }, 2500);

  const result = await generateQuestions(
    topic,
    exam,
    subject,
    count,
    pastedText,
    (completedQs, totalQs, bNum, bTotal) => {
      updateUI(completedQs, totalQs, bNum, bTotal);
    },
    chatId
  );

  clearInterval(animInterval);

  // Check if cancelled
  if (topicInput.get(chatId)?.cancelled) {
    topicInput.delete(chatId);
    return null;
  }

  if (result && result.questions && result.questions.length > 0) {
    const { questions, modelUsed, tokenUsage } = result;
    const modelEmoji = modelUsed.includes('Gemini') ? '🔵' : modelUsed.includes('Groq') ? '🟣' : '🟢';
    const tokenInfo = tokenUsage && tokenUsage.totalTokens > 0
      ? `\n🔤 <b>Tokens Used:</b> <code>${tokenUsage.totalTokens.toLocaleString()} tokens</code>`
      : '';

    try {
      await bot.editMessageText(
        `✨ <b>ExamVault Luminance</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ <b>Manifestation Complete! (${questions.length} Questions Generated)</b>\n\n${getGlowProgressBar(100)}\n\n<i>Topic: ${topic}</i>\n\n${modelEmoji} <b>AI Model:</b> <code>${escapeHTML(modelUsed)}</code>${tokenInfo}`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: 'HTML'
        }
      );
    } catch (e) { }

    // Immediately save to Notion — don't wait for quiz end
    bot.sendMessage(chatId, `💾 <b>Saving ${questions.length} questions to Notion...</b>\n📂 <b>Path:</b> ${escapeHTML(exam)} › ${escapeHTML(subject)} › ${escapeHTML(topic)}`, { parse_mode: 'HTML' });
    saveAllQuestionsToNotion(exam, subject, topic, questions, chatId).catch(e => {
      console.error('Background Notion save failed:', e.message);
    });

    // Auto-update pinned token status message live
    updatePinnedTokenStatus(chatId).catch(() => {});

    return { questions, modelUsed, tokenUsage };
  }

  // Failure fallback
  await bot.sendMessage(chatId, '❌ API fail or limit reached.', { reply_markup: getSettingsKeyboard() });
  return null;
}

// ==================== MESSAGE FORMATTING ====================

function formatQuestion(q, questionNumber, total) {
  const difficulty = q.difficulty === 'Easy' ? '🟢' : q.difficulty === 'Hard' ? '🔴' : '🟡';
  const pyq = q.pyqTag ? `\n🏷️ <b>PYQ:</b> ${escapeHTML(q.pyqTag)}` : '';
  const context = q.context ? `📖 <b>COMMON CONTEXT:</b>\n<i>${escapeHTML(q.context)}</i>\n\n` : '';

  return `
${context}<b>❓ Question ${questionNumber}/${total}</b>
${difficulty} <b>Level:</b> ${escapeHTML(q.difficulty || 'Medium')}${pyq}

<b>${escapeHTML(q.question)}</b>

<b>A)</b> ${escapeHTML(q.optionA)}
<b>B)</b> ${escapeHTML(q.optionB)}
<b>C)</b> ${escapeHTML(q.optionC)}
<b>D)</b> ${escapeHTML(q.optionD)}

<i>Select your answer:</i>
`;
}


function formatAnswer(q, userAnswer) {
  const isCorrect = userAnswer === q.correctAnswer;
  const emoji = isCorrect ? '✅' : '❌';
  const trick = q.trick ? `\n\n<b>💡 Trick/Shortcut:</b>\n${escapeHTML(q.trick)}` : '';

  return `
${emoji} <b>${isCorrect ? 'CORRECT!' : 'INCORRECT!'}</b>

<b>Your Answer:</b> ${escapeHTML(userAnswer)}
<b>Correct Answer:</b> ${escapeHTML(q.correctAnswer)}

${q.explanation ? `📖 <b>Explanation:</b>\n${escapeHTML(q.explanation)}` : ''}${trick}
`;
}


function showBookmarkItem(chatId, messageId) {
  const session = reviewSessions.get(chatId);
  if (!session || !session.items) return;
  const item = session.items[session.current];
  const { q, exam, subject, topic } = item;

  const text = `🔖 <b>Bookmarked Question ${session.current + 1}/${session.items.length}</b>\n` +
    `🏛️ ${escapeHTML(exam)} | 📚 ${escapeHTML(subject)} | 📝 ${escapeHTML(topic)}\n\n` +
    `<b>${escapeHTML(q.question)}</b>\n\n` +
    `<b>A)</b> ${escapeHTML(q.optionA)}\n<b>B)</b> ${escapeHTML(q.optionB)}\n<b>C)</b> ${escapeHTML(q.optionC)}\n<b>D)</b> ${escapeHTML(q.optionD)}\n\n` +
    `✅ <b>Correct Answer:</b> ${escapeHTML(q.correctAnswer)}\n` +
    `📖 <b>Explanation:</b>\n${escapeHTML(q.explanation || 'N/A')}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🗑️ Remove Bookmark', callback_data: 'bm_delete' }],
      session.current + 1 < session.items.length ? [{ text: '➡️ Next Bookmark', callback_data: 'bm_next' }] : [],
      [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
    ].filter(r => r.length > 0)
  };

  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: keyboard
  }).catch(e => {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  });
}

// ==================== KEYBOARD HELPERS ====================

function getAnswerKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔵 A', callback_data: 'ans_A' },
        { text: '🟣 B', callback_data: 'ans_B' }
      ],
      [
        { text: '🟡 C', callback_data: 'ans_C' },
        { text: '🔴 D', callback_data: 'ans_D' }
      ]
    ]
  };
}

function getMainKeyboard(chatId) {
  const keyboard = [
    [
      { text: '📚 Schedule Test', callback_data: 'schedule_test' },
      { text: '📊 My Schedule', callback_data: 'view_schedule' }
    ],
    [
      { text: '🎯 Take Test Now', callback_data: 'take_test' },
      { text: '⚡ Quick Practice', callback_data: 'quick_practice' }
    ],
    [
      { text: '🏆 Full Mock Exam', callback_data: 'mock_exam_menu' },
      { text: '📑 PYQ Simulator', callback_data: 'pyq_menu' }
    ],
    [
      { text: '🤖 AI Tutor', callback_data: 'ai_tutor_start' },
      { text: '🗃️ Flashcards', callback_data: 'flashcards_menu' }
    ],
    [
      { text: '🗺️ AI Syllabus', callback_data: 'syllabus_menu' },
      { text: '📰 Current Affairs', callback_data: 'current_affairs_start' }
    ],
    [
      { text: '📆 Exam Countdown', callback_data: 'countdown_menu' },
      { text: '🌐 Web Dashboard', callback_data: 'web_dashboard_info' }
    ],
    [
      { text: '🏋️ Practice Weak Area', callback_data: 'practice_weak' },
      { text: '🔖 My Bookmarks', callback_data: 'view_bookmarks' }
    ],
    [
      { text: '📈 My Stats', callback_data: 'view_stats' },
      { text: '⚙️ Settings', callback_data: 'settings' }
    ],
    [
      { text: '🔢 Live Token Count', callback_data: 'live_token_count' },
      { text: '📋 Paster', callback_data: 'paster' }
    ]
  ];

  if (isAdmin(chatId)) {
    keyboard.push([{ text: '👑 Admin Panel', callback_data: 'admin_panel' }]);
  }

  return { inline_keyboard: keyboard };
}

function getQuickExamKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎖️ SSC', callback_data: 'qp_exam_SSC' }, { text: '🚂 RRB', callback_data: 'qp_exam_RRB' }],
      [{ text: '🏛️ TNPSC', callback_data: 'qp_exam_TNPSC' }, { text: '🏦 Bank', callback_data: 'qp_exam_Bank' }],
      [{ text: '⚙️ JE', callback_data: 'qp_exam_JE' }],
      [{ text: '🔙 Back', callback_data: 'main_menu' }]
    ]
  };
}

function getQuickSubjectKeyboard(exam) {
  const subjects = EXAM_SUBJECTS[exam] || [];
  const keyboard = [];
  for (let i = 0; i < subjects.length; i += 2) {
    const row = [{ text: subjects[i], callback_data: `qp_subj_${i}` }];
    if (subjects[i + 1]) row.push({ text: subjects[i + 1], callback_data: `qp_subj_${i + 1}` });
    keyboard.push(row);
  }
  keyboard.push([{ text: '🔀 Random Subject', callback_data: 'qp_subj_random' }]);
  return { inline_keyboard: keyboard };
}

function getSettingsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔍 Check Connections', callback_data: 'test_connections' }],
      [{ text: '🔗 Update Notion Key', callback_data: 'update_notion_key' }],
      [{ text: '🆔 Update Notion ID', callback_data: 'update_notion_id' }],
      [{ text: '🔑 Update Gemini Key', callback_data: 'update_gemini_key' }],
      [{ text: '🟣 Update Groq Key', callback_data: 'update_groq_key' }],
      [{ text: '🔑 Update OpenAI Key', callback_data: 'update_openai_key' }],
      [{ text: '🤖 Update Bot Token', callback_data: 'update_bot_token' }],
      [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }]
    ]
  };
}

function getCancelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '❌ Cancel Generation', callback_data: 'cancel_generation' }]
    ]
  };
}

const EXAM_ICONS = {
  'SSC': { emoji: '🎖️', url: 'https://upload.wikimedia.org/wikipedia/en/thumb/e/e6/Staff_Selection_Commission_Logo.svg/1200px-Staff_Selection_Commission_Logo.svg.png' },
  'RRB': { emoji: '🚂', url: 'https://upload.wikimedia.org/wikipedia/en/thumb/4/41/Indian_Railway_Logo.svg/1200px-Indian_Railway_Logo.svg.png' },
  'TNPSC': { emoji: '🏛️', url: 'https://upload.wikimedia.org/wikipedia/en/thumb/1/1a/Seal_of_Tamil_Nadu.svg/512px-Seal_of_Tamil_Nadu.svg.png' },
  'Bank': { emoji: '🏦', url: 'https://upload.wikimedia.org/wikipedia/en/3/3d/IBPS_logo.png' },
  'JE': { emoji: '⚙️', url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Image_created_with_a_mobile_phone.png/220px-Image_created_with_a_mobile_phone.png' }
};

const EXAM_SUBJECTS = {
  'SSC': ['Quants', 'Reasoning', 'History', 'Polity', 'Economy', 'Enivornment', 'Sports', 'Geography', 'Physic', 'Chemistry', 'Biology', 'Gk', 'Current Affairs', 'English'],
  'RRB': ['Quants', 'Reasoning', 'History', 'Polity', 'Economy', 'Enivornment', 'Geography', 'Physic', 'Chemistry', 'Biology', 'Gk', 'Current Affairs', 'English'],
  'TNPSC': ['Tamil', 'English', 'Quants', 'Reasoning', 'History and Culture of india', 'History Culture heritage and Socio political movement in Tamilnadu', 'India National Movement', 'Indian Polity', 'indian economy', 'Geography', 'physics', 'Biology', 'Chemistry', 'Current Affairs'],
  'Bank': ['Quants', 'Reasoning', 'English', 'General Awareness', 'Computer Awareness'],
  'JE': [
    'Fluid Mechanics',
    'Power Plant Engineering',
    'Internal Combustion Engine',
    'Refrigeration and Air Conditioning',
    'Thermodynamics',
    'Heat Transfer',
    'Engineering Mechanics',
    'Strength of Materials',
    'Design of Machine Elements',
    'Theory of Machines',
    'Production Engineering',
    'Engineering Materials Science',
    'Industrial Engineering and Management',
    'Mechanics Dynamics',
    'Kinetics Dynamics',
    'Thermal Engineering',
    'CAD CAM CIM FEA'
  ]
};

const BANK_TOPICS = {
  'Quants': [
    'Number Series', 'Data Interpretation', 'Caselet DI', 'Quadratic Equation', 'HCF & LCM',
    'Simplification', 'Approximation', 'Profit & Loss', 'Simple Interest', 'Compound Interest',
    'Time & Work', 'Time, Speed, & Distance', 'Decimal & Fraction', 'Data Sufficiency',
    'Quantity Based Questions', 'Average', 'Partnership', 'Percentage', 'Mixture & Allegations',
    'Ratio & Proportion', 'Boats and Streams', 'Problems On Trains', 'Ages', 'Mensuration',
    'Pipes and Cisterns', 'Permutation & Combination', 'Probability'
  ],
  'Reasoning': [
    'Puzzles', 'linear seating arrangement', 'circular seating arrangement',
    'square seating arrangement', 'triangular seating arrangement', 'Number Sequence',
    'Input - Output', 'Coding-Decoding', 'Blood Relation', 'Syllogism', 'Alphabet test',
    'Alphanumeric Sequence', 'Order & Ranking', 'Causes and Effects', 'Direction Sense',
    'Word Formation', 'Inequality', 'Statement and Assumption', 'Assertion and Reason',
    'Statement and Conclusion', 'Statement and Arguments', 'Statements and Action Courses'
  ],
  'English': [
    'Reading Comprehensions', 'Grammar / Vyakaran', 'Spotting Errors', 'Fillers',
    'Misspelt Words', 'Jumbled Words', 'Sentence Rearrangement', 'Jumbled sentences',
    'Idioms and Phrases', 'Cloze Tests', 'Match the Column', 'One word Substitution',
    'Sentence correction', 'Identify the Correct Sentence', 'Antonyms and Synonyms',
    'Word Replacement', 'Word Usage', 'Word rearrangement', 'Phrase Replacement',
    'Sentence Connector', 'Sentence Improvement', 'Vocabulary', 'Word Swap',
    'Pairs of words', 'Starters'
  ],
  'General Awareness': [
    'Current Affair', 'Banking Awareness', 'Government Schemes & Policies',
    'Financial awareness', 'Static GK such as Currencies & Capitals', 'Awards & Honors',
    'Books and Authors', 'National Parks & Sanctuaries'
  ],
  'Computer Awareness': [
    'Fundamentals of Computer', 'History of Computers', 'Networking', 'Software & Hardware',
    'Basic Knowledge of the Internet', 'Computer Languages', 'Computer Shortcut Keys',
    'Database', 'Input and Output Devices', 'MS Office', 'Number System',
    'Virus, Hacking, and Security Tools', 'Important computer terminologies and abbreviations'
  ]
};

function getSubjectKeyboard(exam) {
  const subjects = EXAM_SUBJECTS[exam] || [];
  const keyboard = [];
  // Chunk subjects into rows of 2
  for (let i = 0; i < subjects.length; i += 2) {
    const row = [
      { text: subjects[i], callback_data: `subj_${i}` }
    ];
    if (subjects[i + 1]) {
      row.push({ text: subjects[i + 1], callback_data: `subj_${i + 1}` });
    }
    keyboard.push(row);
  }
  return { inline_keyboard: keyboard };
}

// ==================== FEATURE HELPER FUNCTIONS ====================

// --- AI TUTOR HELPER ---
async function handleTutorQuery(chatId, queryText) {
  const statusMsg = await bot.sendMessage(chatId, '🧠 <b>ExamVault AI Tutor is typing...</b>', { parse_mode: 'HTML' });

  try {
    const prompt = `You are ExamVault AI Tutor, an elite 24/7 exam preparation assistant for Indian competitive exams (SSC, RRB NTPC, TNPSC, IBPS/SBI Bank, RRB/SSC JE).
The student asks: "${queryText}"

Provide a clear, highly educational response.
STRICT FORMATTING RULE: Use ONLY basic HTML tags (<b>bold</b>, <i>italic</i>, <code>code</code>). DO NOT use markdown like ** or ## or *.
Structure:
1. Direct Explanation & Answer
2. 💡 ELI5 (Explain Like I'm 5 simple analogy)
3. ⚡ Pro-Tip / Mnemonic / Shortcut formula (if applicable)
Keep response concise, engaging, and under 300 words.`;

    const model = LAST_WORKING_GEMINI_MODEL || 'gemini-1.5-flash';
    let replyText = '';

    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { timeout: 30000 }
      );
      replyText = res.data.candidates[0].content.parts[0].text;
    } catch (e) {
      const groqKey = process.env.GROQ_API_KEY;
      if (groqKey) {
        const groqRes = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] },
          { headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 20000 }
        );
        replyText = groqRes.data.choices[0].message.content;
      } else {
        throw e;
      }
    }

    let cleaned = escapeHTML(replyText)
      .replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, '<b>$1</b>')
      .replace(/&lt;i&gt;(.*?)&lt;\/i&gt;/g, '<i>$1</i>')
      .replace(/&lt;code&gt;(.*?)&lt;\/code&gt;/g, '<code>$1</code>')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<i>$1</i>');

    const keyboard = {
      inline_keyboard: [
        [{ text: '🚪 Exit Tutor Mode', callback_data: 'exit_tutor' }]
      ]
    };

    bot.editMessageText(`🤖 <b>AI Tutor Reply:</b>\n\n${cleaned}`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'HTML',
      reply_markup: keyboard
    }).catch(() => {
      bot.sendMessage(chatId, `🤖 <b>AI Tutor Reply:</b>\n\n${cleaned}`, { parse_mode: 'HTML', reply_markup: keyboard });
    });

  } catch (err) {
    console.error('Tutor Error:', err.message);
    bot.editMessageText(`⚠️ <b>AI Tutor Error:</b> ${escapeHTML(err.message)}`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🚪 Exit Tutor Mode', callback_data: 'exit_tutor' }]] }
    });
  }
}

// --- AI SYLLABUS MAPPER HELPER ---
function showSyllabusMap(chatId, exam, messageId = null) {
  const subjects = EXAM_SUBJECTS[exam] || [];
  const stats = userStats.get(chatId) || { byExam: {} };
  const examStats = stats.byExam[exam] || { correct: 0, total: 0, bySubject: {} };

  let totalQsAnsweredInExam = examStats.total || 0;
  let overallExamAcc = examStats.total > 0 ? Math.round((examStats.correct / examStats.total) * 100) : 0;

  let text = `🗺️ <b>AI Syllabus & Coverage Mapper: ${exam}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📊 <b>Exam Progress:</b> ${totalQsAnsweredInExam} Questions Practiced (${overallExamAcc}% Accuracy)\n\n`;

  text += `📚 <b>Subject Breakdown & Topic Gap Analysis:</b>\n`;

  let unpracticed = [];

  subjects.forEach(subj => {
    const subjData = examStats.bySubject ? examStats.bySubject[subj] : null;
    const total = subjData ? subjData.total : 0;
    const correct = subjData ? subjData.correct : 0;
    const acc = total > 0 ? Math.round((correct / total) * 100) : 0;

    let bar = '';
    if (total === 0) {
      bar = '░░░░░░░░░░ 0%';
      unpracticed.push(subj);
    } else if (total < 10) {
      bar = '███░░░░░░░ Low Practice';
    } else if (acc >= 75) {
      bar = '██████████ ' + acc + '% [MASTERED 🌟]';
    } else if (acc >= 50) {
      bar = '██████░░░░ ' + acc + '% [GOOD 👍]';
    } else {
      bar = '███░░░░░░░ ' + acc + '% [NEEDS FOCUS ⚠️]';
    }

    text += `\n• <b>${escapeHTML(subj)}</b>\n  <code>${bar}</code> (${total} Qs)\n`;
  });

  if (unpracticed.length > 0) {
    text += `\n💡 <b>Recommended Gaps to Cover Next:</b>\n`;
    unpracticed.slice(0, 3).forEach(s => {
      text += `👉 <i>${escapeHTML(s)}</i>\n`;
    });
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '⚡ Practice Gap Subject Now', callback_data: `qp_exam_${exam}` }],
      [{ text: '🔙 Back to Main Menu', callback_data: 'main_menu' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// --- FLASHCARD HELPER ---
function showFlashcardMenu(chatId, messageId = null) {
  const cards = userFlashcards.get(chatId) || [];
  const text = `🗃️ <b>Formula & Fact Flashcard Mode</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Saved Flashcards in Vault: <b>${cards.length}</b>\n\n` +
    `Select an option below to generate new AI flashcards or review your collection:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '⚡ Generate New AI Flashcards', callback_data: 'gen_flashcards_select' }],
      cards.length > 0 ? [{ text: `📖 Review Saved Flashcards (${cards.length})`, callback_data: 'review_flashcards' }] : [],
      [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
    ].filter(r => r.length > 0)
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

async function generateFlashcards(chatId, exam, subject, messageId = null) {
  const statusText = `🗃️ <b>Generating AI Flashcards...</b>\n\nSubject: <b>${subject} (${exam})</b>\nCreating key formulas, definitions, and facts...`;
  if (messageId) {
    bot.editMessageText(statusText, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
  } else {
    bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
  }

  const prompt = `Generate 5 high-yield revision flashcards for ${exam} exam on ${subject}.
Output JSON ONLY with format:
{
  "flashcards": [
    {
      "term": "Concept/Formula Name or Question",
      "definition": "Clear concise formula, rule, or explanation (under 50 words)"
    }
  ]
}`;

  try {
    const model = LAST_WORKING_GEMINI_MODEL || 'gemini-1.5-flash';
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } },
      { timeout: 30000 }
    );

    const parsed = JSON.parse(res.data.candidates[0].content.parts[0].text);
    const newCards = parsed.flashcards || [];

    const existing = userFlashcards.get(chatId) || [];
    newCards.forEach(c => {
      existing.push({ term: c.term, definition: c.definition, subject, exam, box: 1, lastReviewed: new Date().toISOString() });
    });
    userFlashcards.set(chatId, existing);
    saveFlashcards();

    activeFlashcardSessions.set(chatId, { cards: newCards, current: 0, showingAnswer: false });
    renderFlashcard(chatId);

  } catch (err) {
    console.error('Flashcard Generation Error:', err.message);
    bot.sendMessage(chatId, `❌ Failed to generate flashcards: ${escapeHTML(err.message)}`, { reply_markup: getMainKeyboard(chatId) });
  }
}

function renderFlashcard(chatId, messageId = null) {
  const session = activeFlashcardSessions.get(chatId);
  if (!session || !session.cards || session.cards.length === 0) return;

  const card = session.cards[session.current];
  const total = session.cards.length;

  let text = `🗃️ <b>Flashcard ${session.current + 1}/${total}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (!session.showingAnswer) {
    text += `❓ <b>QUESTION / CONCEPT:</b>\n\n<b>${escapeHTML(card.term)}</b>\n\n<i>Tap below to reveal formula/answer...</i>`;
  } else {
    text += `❓ <b>CONCEPT:</b>\n<b>${escapeHTML(card.term)}</b>\n\n💡 <b>FORMULA / EXPLANATION:</b>\n${escapeHTML(card.definition)}`;
  }

  const keyboard = { inline_keyboard: [] };

  if (!session.showingAnswer) {
    keyboard.inline_keyboard.push([{ text: '👁️ Reveal Answer', callback_data: 'fc_reveal' }]);
  } else {
    keyboard.inline_keyboard.push([
      { text: '✅ Know It', callback_data: 'fc_know' },
      { text: '🔄 Review Again', callback_data: 'fc_again' }
    ]);
  }

  keyboard.inline_keyboard.push([{ text: '🏠 Main Menu', callback_data: 'main_menu' }]);

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// --- EXAM COUNTDOWN DASHBOARD HELPER ---
function showCountdownDashboard(chatId, messageId = null) {
  const entry = userExamDates.get(chatId);

  if (!entry) {
    const text = `📆 <b>Exam Countdown Dashboard</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
      `No target exam date set yet.\n\nSetting a target exam date helps you track remaining days and calculates your recommended daily question quota!`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🎯 Set My Exam Target Date', callback_data: 'set_countdown_exam' }],
        [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
      ]
    };

    if (messageId) {
      bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    } else {
      bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
    return;
  }

  const targetDate = new Date(entry.targetDate);
  const now = new Date();
  const diffTime = targetDate - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  const stats = userStats.get(chatId);
  const totalDone = stats ? stats.totalQuestions : 0;
  const remainingQuestions = Math.max(0, 1000 - totalDone);
  const dailyTarget = diffDays > 0 ? Math.ceil(remainingQuestions / diffDays) : 0;

  let daysEmoji = diffDays <= 10 ? '🚨' : diffDays <= 30 ? '⏳' : '🗓️';

  let text = `📆 <b>Exam Countdown Dashboard</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🏛️ <b>Target Exam:</b> ${escapeHTML(entry.exam)}\n` +
    `🎯 <b>Exam Date:</b> <code>${targetDate.toDateString()}</code>\n` +
    `${daysEmoji} <b>Days Remaining:</b> <b>${diffDays > 0 ? diffDays : 0} Days</b>\n\n` +
    `📊 <b>Syllabus Target Progress:</b>\n` +
    `• Questions Practiced: <code>${totalDone} / 1000</code>\n` +
    `• Target Remaining:    <code>${remainingQuestions} Qs</code>\n` +
    `• Recommended Quota:   <b><code>${dailyTarget} Qs / day</code></b>\n\n` +
    `<i>Stay consistent every day to beat your target!</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '✏️ Update Exam Date', callback_data: 'set_countdown_exam' }],
      [{ text: '🎯 Take Recommended Daily Quiz (' + (dailyTarget || 10) + ' Qs)', callback_data: `take_countdown_quiz_${dailyTarget || 10}_${entry.exam}` }],
      [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// --- MOCK EXAM & PYQ SIMULATOR HELPERS ---
function showMockExamMenu(chatId, messageId = null) {
  const text = `🏆 <b>Full-Length Timed Mock Exam Mode</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Simulates real official exam conditions:\n` +
    `• ⏱️ Timed Session\n` +
    `• 🔒 Instant answer feedback is HIDDEN\n` +
    `• 📈 Final Scorecard & Detailed Breakdown at the end!\n\n` +
    `Select your Exam:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🎖️ SSC CGL Mock (25 Qs)', callback_data: 'start_mock_SSC_25' }],
      [{ text: '🚂 RRB NTPC Mock (30 Qs)', callback_data: 'start_mock_RRB_30' }],
      [{ text: '🏛️ TNPSC Prelims Mock (30 Qs)', callback_data: 'start_mock_TNPSC_30' }],
      [{ text: '🏦 Bank Prelims Mock (35 Qs)', callback_data: 'start_mock_Bank_35' }],
      [{ text: '⚙️ JE Technical Mock (30 Qs)', callback_data: 'start_mock_JE_30' }],
      [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

function showPyqMenu(chatId, messageId = null) {
  const text = `📑 <b>Official Previous Year Question (PYQ) Simulator</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Practice actual official question papers from 2020-2025!\n\nSelect a PYQ Paper:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🎖️ SSC CGL 2023 Official PYQ', callback_data: 'start_pyq_SSC_2023' }],
      [{ text: '🚂 RRB NTPC 2021 Official PYQ', callback_data: 'start_pyq_RRB_2021' }],
      [{ text: '🏛️ TNPSC Group 4 2022 PYQ', callback_data: 'start_pyq_TNPSC_2022' }],
      [{ text: '🏦 IBPS PO 2023 Official PYQ', callback_data: 'start_pyq_Bank_2023' }],
      [{ text: '⚙️ RRB JE 2019 Official PYQ', callback_data: 'start_pyq_JE_2019' }],
      [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

async function startMockOrPyqSession(chatId, exam, count, title, isPyq = false) {
  bot.sendMessage(chatId, `🚀 <b>Preparing ${title}...</b>\nGenerating ${count} exam-standard questions. Please wait...`, { parse_mode: 'HTML' });

  const result = await generateQuestionsWithAnimation(chatId, title, exam, 'Full Exam', count);
  if (!result) return;

  const { questions, modelUsed } = result;

  activeMockExams.set(chatId, {
    title,
    exam,
    questions,
    current: 0,
    userAnswers: [],
    startTime: Date.now(),
    modelUsed,
    isPyq
  });

  renderMockQuestion(chatId);
}

function renderMockQuestion(chatId, messageId = null) {
  const session = activeMockExams.get(chatId);
  if (!session) return;

  const q = session.questions[session.current];
  const total = session.questions.length;
  const elapsedSec = Math.round((Date.now() - session.startTime) / 1000);
  const min = Math.floor(elapsedSec / 60);
  const sec = elapsedSec % 60;
  const timeStr = `${min}m ${sec}s`;

  const text = `🏆 <b>${escapeHTML(session.title)}</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `⏱️ <b>Elapsed Time:</b> <code>${timeStr}</code>\n` +
    `❓ <b>Question ${session.current + 1}/${total}</b>\n\n` +
    `<b>${escapeHTML(q.question)}</b>\n\n` +
    `<b>A)</b> ${escapeHTML(q.optionA)}\n` +
    `<b>B)</b> ${escapeHTML(q.optionB)}\n` +
    `<b>C)</b> ${escapeHTML(q.optionC)}\n` +
    `<b>D)</b> ${escapeHTML(q.optionD)}\n\n` +
    `<i>Select your choice (Answers remain hidden until test end):</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔵 A', callback_data: 'mock_ans_A' },
        { text: '🟣 B', callback_data: 'mock_ans_B' }
      ],
      [
        { text: '🟡 C', callback_data: 'mock_ans_C' },
        { text: '🔴 D', callback_data: 'mock_ans_D' }
      ],
      [{ text: '⏭️ Skip Question', callback_data: 'mock_ans_SKIP' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

function finishMockExam(chatId, messageId) {
  const session = activeMockExams.get(chatId);
  if (!session) return;

  const totalSec = Math.round((Date.now() - session.startTime) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  let correctCount = 0;
  let wrongAnswers = [];

  session.questions.forEach((q, idx) => {
    const userAns = session.userAnswers[idx];
    if (userAns === q.correctAnswer) {
      correctCount++;
    } else {
      wrongAnswers.push({ q, userAnswer: userAns || 'Skipped' });
    }
  });

  const total = session.questions.length;
  const pct = Math.round((correctCount / total) * 100);
  const grade = pct >= 80 ? '🏆 Master Class Pass!' : pct >= 60 ? '🎉 Good Score!' : '💪 Keep Practicing!';

  recordQuizStats(chatId, session.exam, 'Full Mock Exam', correctCount, total);

  let text = `🏁 <b>${escapeHTML(session.title)} — FINAL SCORECARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏆 <b>Score:</b> ${correctCount} / ${total}\n` +
    `📊 <b>Accuracy:</b> ${pct}%\n` +
    `⏱️ <b>Total Time Taken:</b> ${min}m ${sec}s\n` +
    `⚡ <b>Avg Speed:</b> ${Math.round(totalSec / total)}s / question\n\n` +
    `🎯 <b>Exam Grade:</b> ${grade}\n` +
    `🤖 <b>AI Generator:</b> <code>${escapeHTML(session.modelUsed)}</code>\n\n` +
    `<i>All questions synced to your Notion Vault!</i>`;

  const keyboard = {
    inline_keyboard: [
      wrongAnswers.length > 0 ? [{ text: `🔁 Review ${wrongAnswers.length} Wrong / Skipped Answers`, callback_data: 'review_wrong' }] : [],
      [{ text: '📈 View My Stats', callback_data: 'view_stats' }],
      [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
    ].filter(r => r.length > 0)
  };

  if (wrongAnswers.length > 0) {
    reviewSessions.set(chatId, { wrong: wrongAnswers, current: 0 });
  }

  bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  activeMockExams.delete(chatId);
}

// ==================== COMMAND HANDLERS ====================

// --- ADMIN COMMANDS ---

bot.onText(/\/users/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const userList = Array.from(allUsers);
  let response = `👥 <b>User Management System</b>\n━━━━━━━━━━━━━━━━━━━━\nTotal Users: <b>${userList.length}</b>\n\n`;
  
  userList.forEach((uid, index) => {
    response += `${index + 1}. <code>${uid}</code>${uid === ADMIN_ID ? ' (Admin)' : ''}\n`;
  });

  bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
});

bot.onText(/\/adduser (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const targetId = parseInt(match[1]);
  if (isNaN(targetId)) {
    return bot.sendMessage(chatId, '❌ Invalid User ID. Please provide a numeric ID.');
  }

  if (allUsers.has(targetId)) {
    return bot.sendMessage(chatId, `⚠️ User <code>${targetId}</code> is already in the system.`, { parse_mode: 'HTML' });
  }

  allUsers.add(targetId);
  saveUsers();
  bot.sendMessage(chatId, `✅ User <code>${targetId}</code> has been added to the management system.`, { parse_mode: 'HTML' });
});

bot.onText(/\/removeuser (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const targetId = parseInt(match[1]);
  if (isNaN(targetId)) {
    return bot.sendMessage(chatId, '❌ Invalid User ID. Please provide a numeric ID.');
  }

  if (targetId === ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ You cannot remove the Admin user.');
  }

  if (!allUsers.has(targetId)) {
    return bot.sendMessage(chatId, `⚠️ User <code>${targetId}</code> not found in the system.`, { parse_mode: 'HTML' });
  }

  allUsers.delete(targetId);
  saveUsers();
  bot.sendMessage(chatId, `✅ User <code>${targetId}</code> has been removed from the system.`, { parse_mode: 'HTML' });
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const broadcastMsg = match[1];
  const userList = Array.from(allUsers);
  let successCount = 0;

  bot.sendMessage(chatId, `🚀 Starting broadcast to ${userList.length} users...`);

  userList.forEach(uid => {
    bot.sendMessage(uid, `📢 <b>BROADCAST MESSAGE</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${broadcastMsg}`, { parse_mode: 'HTML' })
      .then(() => { successCount++; })
      .catch((err) => { console.error(`Failed to send broadcast to ${uid}:`, err.message); });
  });

  setTimeout(() => {
    bot.sendMessage(chatId, `✅ Broadcast complete. Successfully sent to ${successCount} users.`);
  }, 2000);
});

// --- USER COMMANDS ---

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  // Track User
  if (!allUsers.has(chatId)) {
    allUsers.add(chatId);
    saveUsers();
  }

  // Get live token & model status for welcome message
  const status = await getLiveTokenStatus();

  const welcomeText = `
🎯 <b>Welcome to ExamVault Advanced Bot!</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🤖 Live AI Model & Token Status:</b>
• 🔵 <b>Gemini:</b> ${status.gemini.details}
• 🟣 <b>Groq (Llama 3.3):</b> ${status.groq.details}
• 🟢 <b>OpenAI:</b> ${status.openai.details}
• 📂 <b>Notion Vault:</b> ${status.notion.details}

<b>Exams Covered:</b>
✅ SSC (CGL, CHSL, MTS, GD)
✅ Railway (RRB NTPC, Group D, ALP)
✅ TNPSC (Group 1, 2, 4)
✅ Banking (IBPS, SBI)
✅ JE — Junior Engineer (RRB JE, SSC JE, GATE ME)

<b>How it works:</b>
1️⃣ Schedule a test topic tonight
2️⃣ Questions are AI-generated & Saved to Notion
3️⃣ Test runs at your scheduled time

<b>Ready?</b> Click below to schedule your first test!
`;

  await bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'HTML',
    reply_markup: getMainKeyboard(chatId)
  });

  // Pin live token status dashboard message in background
  updatePinnedTokenStatus(chatId).catch(err => {
    console.warn('Failed to update pinned token message:', err.message);
  });
});

bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  showAdminPanel(chatId);
});

function showAdminPanel(chatId, messageId = null) {
  const text = `👑 <b>Admin Control Center</b>\n━━━━━━━━━━━━━━━━━━━━\nSelect an administrative action:`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '👥 Manage Users', callback_data: 'admin_manage_users' }],
      [{ text: '📢 New Broadcast', callback_data: 'admin_broadcast' }],
      [{ text: '📊 Global Stats (Soon)', callback_data: 'no_op' }],
      [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => { });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

function showUserManagement(chatId, messageId) {
  const userList = Array.from(allUsers);
  let text = `👥 <b>User Management</b>\n━━━━━━━━━━━━━━━━━━━━\nClick on a user ID to see options:\n\n`;
  const keyboard = [];

  userList.forEach(uid => {
    keyboard.push([{ text: `👤 User: ${uid}${uid === ADMIN_ID ? ' (Admin)' : ''}`, callback_data: `admin_user_info_${uid}` }]);
  });

  keyboard.push([{ text: '🔙 Back to Admin', callback_data: 'admin_panel' }]);

  bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(() => { });
}

bot.onText(/\/schedule/, (msg) => {
  const chatId = msg.chat.id;
  topicInput.set(chatId, { step: 1, mode: 'schedule' });

  bot.sendMessage(chatId, 'Select the <b>Exam</b> you want to prepare for:', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎖️ SSC', callback_data: 'exam_SSC' }],
        [{ text: '🚂 RRB', callback_data: 'exam_RRB' }],
        [{ text: '🏛️ TNPSC', callback_data: 'exam_TNPSC' }],
        [{ text: '🏦 Bank', callback_data: 'exam_Bank' }],
        [{ text: '⚙️ JE (Junior Engineer)', callback_data: 'exam_JE' }]
      ]
    }
  });
});

bot.onText(/\/tokens/, async (msg) => {
  const chatId = msg.chat.id;
  const text = formatLiveTokenCountMessage();
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh Count', callback_data: 'refresh_live_tokens' },
        { text: '🔍 Check Connections', callback_data: 'test_connections' }
      ],
      [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
    ]
  };
  bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
});

// --- NEW FEATURE COMMAND HANDLERS ---

// Feature 39: AI Tutor Mode
bot.onText(/\/tutor(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const initialQuery = match[1] ? match[1].trim() : null;

  activeTutorSessions.set(chatId, { active: true, startTime: Date.now() });

  let text = `🤖 <b>ExamVault AI Tutor Mode Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nI am your dedicated 24/7 AI tutor for <b>SSC, RRB, TNPSC, Banking & JE Exams</b>.\n\nAsk me anything! Concepts, math problems, shortcuts, history dates, or doubts.\n\n💡 <i>Type <code>/exit</code> or tap below anytime to leave Tutor Mode.</i>`;

  const keyboard = {
    inline_keyboard: [[{ text: '🚪 Exit Tutor Mode', callback_data: 'exit_tutor' }]]
  };

  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });

  if (initialQuery) {
    handleTutorQuery(chatId, initialQuery);
  }
});

bot.onText(/\/exit/, (msg) => {
  const chatId = msg.chat.id;
  if (activeTutorSessions.has(chatId)) {
    activeTutorSessions.delete(chatId);
    bot.sendMessage(chatId, '🚪 <b>Exited AI Tutor Mode.</b> Back to Main Menu!', { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
  }
});

// Feature 16: AI Syllabus Mapper
bot.onText(/\/syllabus(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const examArg = match[1] ? match[1].trim().toUpperCase() : null;

  if (!examArg || !['SSC', 'RRB', 'TNPSC', 'BANK', 'JE'].includes(examArg)) {
    return bot.sendMessage(chatId, `🗺️ <b>AI Syllabus Mapper</b>\n━━━━━━━━━━━━━━━━━━━━\nPlease select an exam to map your syllabus coverage:`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎖️ SSC', callback_data: 'syl_SSC' }, { text: '🚂 RRB', callback_data: 'syl_RRB' }],
          [{ text: '🏛️ TNPSC', callback_data: 'syl_TNPSC' }, { text: '🏦 Bank', callback_data: 'syl_Bank' }],
          [{ text: '⚙️ JE', callback_data: 'syl_JE' }],
          [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  }

  showSyllabusMap(chatId, examArg);
});

// Feature 17: Daily Current Affairs Digest
bot.onText(/\/currentaffairs/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📰 <b>Generating Today\'s High-Yield Current Affairs Digest (2025-2026)...</b>', { parse_mode: 'HTML' });

  const result = await generateQuestionsWithAnimation(chatId, 'Current Affairs 2025-2026', 'SSC', 'Current Affairs', 5);
  if (!result) return;

  const { questions, modelUsed } = result;
  activeQuizzes.set(chatId, {
    questions, current: 0, score: 0,
    topic: 'Current Affairs 2025-2026', subject: 'Current Affairs', exam: 'SSC', modelUsed, wrongAnswers: [],
    questionStartTime: Date.now(), totalTime: 0
  });

  bot.sendMessage(chatId, formatQuestion(questions[0], 1, questions.length), {
    parse_mode: 'HTML', reply_markup: getAnswerKeyboard()
  });
});

// Feature 23: Formula & Fact Flashcard Mode
bot.onText(/\/flashcard/, async (msg) => {
  const chatId = msg.chat.id;
  showFlashcardMenu(chatId);
});

// Feature 34: Exam Countdown Dashboard
bot.onText(/\/countdown/, async (msg) => {
  const chatId = msg.chat.id;
  showCountdownDashboard(chatId);
});

// Feature 5 & 27: Mock Full Exam & PYQ Simulator
bot.onText(/\/mock/, (msg) => {
  const chatId = msg.chat.id;
  showMockExamMenu(chatId);
});

bot.onText(/\/pyq/, (msg) => {
  const chatId = msg.chat.id;
  showPyqMenu(chatId);
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `
🎯 <b>ExamVault Bot Command Reference</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📚 Practice & Exams:</b>
• <code>/schedule</code> — Schedule a test for tonight / 7 AM
• <code>/mock</code> — Start a full-length timed mock exam
• <code>/pyq</code> — Practice official Previous Year Question papers
• <code>/currentaffairs</code> — Instant 5 Current Affairs 2025-2026 MCQs
• <code>/flashcard</code> — Formula & key fact revision cards

<b>🧠 AI Learning Tools:</b>
• <code>/tutor [query]</code> — Enter interactive 24/7 AI tutor mode
• <code>/exit</code> — Leave AI Tutor mode
• <code>/syllabus [exam]</code> — Map your syllabus coverage & topic gaps

<b>📊 Analytics & Tracking:</b>
• <code>/countdown</code> — Target exam date countdown & daily question target
• <code>/stats</code> — Performance dashboard & accuracy breakdown
• <code>/tokens</code> — Live AI token count & quota dashboard

<b>⚙️ Settings & System:</b>
• <code>/start</code> — Main Menu & system status
• <code>/help</code> — This reference guide
`;
  bot.sendMessage(chatId, helpText, { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
});

// Global input listener
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;

  // Intercept AI Tutor queries if user is in active tutor mode
  if (activeTutorSessions.has(chatId) && !msg.text.startsWith('/')) {
    handleTutorQuery(chatId, msg.text.trim());
    return;
  }

  const input = topicInput.get(chatId);
  if (!input) return;

  // Handle countdown target date input
  if (input.step === 'set_countdown_date') {
    const dateStr = msg.text.trim();
    const parsedDate = new Date(dateStr);

    if (isNaN(parsedDate.getTime()) || parsedDate <= new Date()) {
      bot.sendMessage(chatId, '❌ <b>Invalid Date.</b> Please enter a future date in format <code>YYYY-MM-DD</code> (e.g., <code>2026-10-15</code>):', { parse_mode: 'HTML' });
      return;
    }

    userExamDates.set(chatId, {
      exam: input.exam || 'SSC',
      targetDate: parsedDate.toISOString()
    });
    saveExamDates();
    topicInput.delete(chatId);

    bot.sendMessage(chatId, `✅ <b>Target Exam Date Saved!</b>`, { parse_mode: 'HTML' });
    showCountdownDashboard(chatId);
    return;
  }

  if (input.step === 'update_gemini_key') {
    const tempKey = msg.text.trim();
    bot.sendMessage(chatId, '🔍 <b>Testing Gemini API Key...</b>', { parse_mode: 'HTML' });

    try {
      // Use the same fallback logic for verification
      const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];
      let workingModel = null;
      let lastError = null;
      let quotaExceededError = false;

      for (const model of models) {
        try {
          await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${tempKey}`, {
            contents: [{ parts: [{ text: 'hi' }] }]
          });
          workingModel = model;
          break;
        } catch (e) {
          lastError = e;
          const status = e.response?.status;
          if (status === 429) {
            quotaExceededError = true;
          }
        }
      }

      if (workingModel) {
        GEMINI_API_KEY = tempKey;
        updateEnvFile('GEMINI_API_KEY', tempKey);
        LAST_WORKING_GEMINI_MODEL = workingModel;
        bot.sendMessage(chatId, `✅ <b>Gemini Key Verified!</b>\n\nWorking model: <code>${workingModel}</code>\nYour key has been saved.`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
        topicInput.delete(chatId);
      } else if (quotaExceededError) {
        GEMINI_API_KEY = tempKey;
        updateEnvFile('GEMINI_API_KEY', tempKey);
        bot.sendMessage(chatId, `⚠️ <b>Gemini Key Valid but Quota Exceeded</b>\n\nThe key is valid, but you have no credits left for today. It has been saved anyway.`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
        topicInput.delete(chatId);
      } else {
        const reason = lastError?.response?.data?.error?.message || lastError?.message || 'Unknown Error';
        bot.sendMessage(chatId, `❌ <b>Gemini Key Invalid</b>\n\nReason: ${reason}`, { parse_mode: 'HTML' });
      }
    } catch (e) {
      bot.sendMessage(chatId, `❌ <b>Connection Error</b>\n\n${e.message}`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (input.step === 'update_groq_key') {
    const tempKey = msg.text.trim();
    bot.sendMessage(chatId, '🔍 <b>Testing Groq API Key...</b>', { parse_mode: 'HTML' });

    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 },
        { headers: { 'Authorization': `Bearer ${tempKey}`, 'Content-Type': 'application/json' }, timeout: 8000 }
      );

      if (res.data && res.data.choices) {
        updateEnvFile('GROQ_API_KEY', tempKey);
        process.env.GROQ_API_KEY = tempKey;
        await bot.sendMessage(chatId,
          `✅ <b>Groq Key Verified &amp; Saved!</b>\n\n🟣 <b>Model:</b> <code>Llama 3.3 70B (Versatile)</code>\n🔑 Your key has been saved and is now active.`,
          { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) }
        );
        // Refresh pinned dashboard with new status
        updatePinnedTokenStatus(chatId, true).catch(() => {});
      } else {
        throw new Error('Unexpected response from Groq API.');
      }
    } catch (e) {
      const errMsg = e.response?.data?.error?.message || e.message || 'Unknown Error';
      const isQuota = errMsg.toLowerCase().includes('quota') || e.response?.status === 429;
      if (isQuota) {
        // Key is valid but quota hit — save it anyway
        updateEnvFile('GROQ_API_KEY', tempKey);
        process.env.GROQ_API_KEY = tempKey;
        await bot.sendMessage(chatId,
          `⚠️ <b>Groq Key Valid but Rate Limited</b>\n\nYour key is correct but you've hit the free-tier rate limit. It has been saved — try again in a minute.`,
          { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) }
        );
        updatePinnedTokenStatus(chatId, true).catch(() => {});
      } else {
        await bot.sendMessage(chatId,
          `❌ <b>Groq Key Invalid</b>\n\nReason: ${escapeHTML(errMsg)}\n\n💡 Get a free key at <a href="https://console.groq.com/keys">console.groq.com/keys</a>`,
          { parse_mode: 'HTML' }
        );
      }
    }
    topicInput.delete(chatId);
    return;
  }

  if (input.step === 'update_openai_key') {
    const tempKey = msg.text.trim();
    bot.sendMessage(chatId, '🔍 <b>Testing OpenAI API Key...</b>', { parse_mode: 'HTML' });

    // Always save the key first to ensure it's recorded
    OPENAI_API_KEY = tempKey;
    updateEnvFile('OPENAI_API_KEY', tempKey);

    try {
      const testRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }]
      }, {
        headers: { 'Authorization': `Bearer ${tempKey}` }
      });

      if (testRes.data && testRes.data.choices) {
        bot.sendMessage(chatId, `✅ <b>OpenAI Key Saved & Verified!</b>`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
      } else {
        throw new Error('Key saved, but API response was unexpected.');
      }
    } catch (e) {
      const errorMsg = e.response?.data?.error?.message || e.message;
      bot.sendMessage(chatId, `⚠️ <b>OpenAI Key Saved But Test Failed</b>\n\nReason: ${errorMsg}\n\nThe key has been saved, but it might not work until you fix the quota/balance issue.`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
    }
    topicInput.delete(chatId);
    return;
  }
  if (input.step === 'update_notion_key') {
    NOTION_KEY = msg.text.trim();
    updateEnvFile('NOTION_API_KEY', NOTION_KEY);
    bot.sendMessage(chatId, '✅ <b>Notion API Key saved!</b>', { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
    topicInput.delete(chatId);
    return;
  }
  if (input.step === 'update_notion_id') {
    NOTION_PARENT_DB = msg.text.trim();
    updateEnvFile('NOTION_PARENT_DB', NOTION_PARENT_DB);
    bot.sendMessage(chatId, '✅ <b>Notion Parent ID saved!</b>', { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
    topicInput.delete(chatId);
    return;
  }
  if (input.step === 'update_bot_token') {
    const newToken = msg.text.trim();
    updateEnvFile('TELEGRAM_BOT_TOKEN', newToken);
    bot.sendMessage(chatId, '✅ <b>Bot Token saved to .env!</b>\n\n⚠️ You must <b>Restart the bot</b> manually for the new token to take effect.', { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
    topicInput.delete(chatId);
    return;
  }

  // Handle Admin Broadcast Input
  if (input.step === 'admin_broadcast_input') {
    const broadcastMsg = msg.text.trim();
    const userList = Array.from(allUsers);
    let successCount = 0;

    bot.sendMessage(chatId, `🚀 Starting broadcast to ${userList.length} users...`);

    userList.forEach(uid => {
      bot.sendMessage(uid, `📢 <b>BROADCAST MESSAGE</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${broadcastMsg}`, { parse_mode: 'HTML' })
        .then(() => { successCount++; })
        .catch((err) => { console.error(`Failed to send broadcast to ${uid}:`, err.message); });
    });

    setTimeout(() => {
      bot.sendMessage(chatId, `✅ Broadcast complete. Successfully sent to ${successCount} users.`, { reply_markup: getMainKeyboard(chatId) });
    }, 2000);

    topicInput.delete(chatId);
    return;
  }

  // Multi-step Flow: Subject -> Topic -> Count -> [Time]

  // Step 3: Topic Input (after Subject Selection)
  if (input.step === 3) {
    input.topic = msg.text.trim();
    if (input.mode === 'paster') {
      input.step = 'paster_text';
      bot.sendMessage(chatId, `🏷️ <b>Topic Name:</b> ${input.topic}\n\nNow, please <b>PASTE the Text/Content</b> you want to generate questions from:`, { parse_mode: 'HTML' });
      return;
    }

    input.step = 4;
    const isBankSetBased = isBankSetBasedHelper(input.exam, input.topic);

    if (isBankSetBased) {
      bot.sendMessage(chatId, `This is a <b>Set-based topic</b>.
How many <b>Sets</b> do you want to generate? (1 Set = 1 Context + 5 Questions).
Please enter the number of Sets (e.g., 1, 2, 3).
(Default: 2 sets = 10 questions)`, { parse_mode: 'HTML' });
      return;
    } else {
      bot.sendMessage(chatId, `How many <b>Questions</b> would you like to generate? (e.g., 5, 10, 20)\n<i>(Default: 10 if you type anything else)</i>`, { parse_mode: 'HTML' });
      return;
    }
  }

  // Paster Text Input
  if (input.step === 'paster_text') {
    input.pastedText = msg.text.trim();
    input.step = 4;
    bot.sendMessage(chatId, `📋 <b>Text Received!</b>\n\nHow many <b>Questions</b> would you like to generate from this text? (e.g., 5, 10, 20)\n<i>(Default: 10 if you type anything else)</i>`, { parse_mode: 'HTML' });
    return;
  }

  // Step 4: Count -> [Time or Execute]
  if (input.step === 4) {
    const isBankSetBased = isBankSetBasedHelper(input.exam, input.topic);
    let countInput = parseInt(msg.text.trim()) || 0;
    let count;

    if (isBankSetBased) {
      let sets = countInput || 2;
      if (sets < 1) sets = 1;
      count = sets * 5;
    } else {
      count = countInput || 10;
      if (count < 1) count = 10;
    }

    input.count = count;

    if (input.mode === 'take_now' || input.mode === 'paster') {
      const result = await generateQuestionsWithAnimation(chatId, input.topic, input.exam, input.subject, count, input.pastedText);

      if (!result) {
        topicInput.delete(chatId);
        return;
      }

      const { questions, modelUsed } = result;
      activeQuizzes.set(chatId, { questions, current: 0, score: 0, topic: input.topic, subject: input.subject, exam: input.exam, modelUsed });
      bot.sendMessage(chatId, `🎯 <b>Test ready! ${questions.length} questions loaded.</b>\n\n🤖 <b>Generated by:</b> <code>${escapeHTML(modelUsed)}</code>\n💾 <b>Notion save is running in the background.</b>`, { parse_mode: 'HTML' });
      bot.sendMessage(chatId, formatQuestion(questions[0], 1, questions.length), { parse_mode: 'HTML', reply_markup: getAnswerKeyboard() });
      topicInput.delete(chatId);
    } else {
      input.step = 5;
      bot.sendMessage(chatId, `Enter the <b>Time</b> for the test (24h format, e.g. 07:00, 15:30):`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Step 5: Time -> Finalize Schedule
  if (input.step === 5) {
    const timeStr = msg.text.trim();
    const [hrStr, minStr] = timeStr.split(':');
    let hours = parseInt(hrStr, 10);
    let mins = parseInt(minStr, 10) || 0;

    if (isNaN(hours) || hours < 0 || hours > 23) {
      bot.sendMessage(chatId, '❌ Invalid time format. Please use HH:mm (e.g. 07:00).');
      return;
    }

    const scheduledDate = new Date();
    scheduledDate.setHours(hours, mins, 0, 0);
    // If the scheduled time is strictly in the past (by more than a minute), move to tomorrow
    if (scheduledDate.getTime() + 60000 < Date.now()) {
      scheduledDate.setDate(scheduledDate.getDate() + 1);
    }

    userSchedules.set(chatId, {
      exam: input.exam,
      subject: input.subject,
      topic: input.topic,
      count: input.count,
      scheduledFor: scheduledDate,
      status: 'scheduled'
    });

    saveSchedules();

    bot.sendMessage(chatId, `✅ <b>Test Scheduled!</b>\n\n⏰ <b>Time:</b> ${scheduledDate.toLocaleTimeString()}\n📂 <b>Topic:</b> ${input.topic} (${input.count} questions)`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
    topicInput.delete(chatId);
    return;
  }
});

// ==================== CALLBACK HANDLERS ====================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    // Answer selection
    if (data.startsWith('ans_')) {
      const answer = data.split('_')[1];
      const quiz = activeQuizzes.get(chatId);

      if (!quiz) {
        bot.answerCallbackQuery(query.id, 'Please start a test first!');
        return;
      }

      const q = quiz.questions[quiz.current];
      const isCorrect = answer === q.correctAnswer;

      const timeTakenSec = quiz.questionStartTime ? Math.round((Date.now() - quiz.questionStartTime) / 1000) : 0;
      quiz.totalTime = (quiz.totalTime || 0) + timeTakenSec;
      quiz.questionStartTime = null;

      if (isCorrect) {
        quiz.score++;
      } else {
        if (!quiz.wrongAnswers) quiz.wrongAnswers = [];
        quiz.wrongAnswers.push({ q, userAnswer: answer });
      }

      // Show answer and AI Tutor interaction
      try {
        const feedbackKeyboard = { inline_keyboard: [] };

        feedbackKeyboard.inline_keyboard.push([{ text: '💡 Ask AI to Explain Deeper', callback_data: `deepdive_${quiz.current}_${answer}` }]);
        feedbackKeyboard.inline_keyboard.push([{ text: '⭐ Star Question', callback_data: `star_q_${quiz.current}_${answer}` }]);

        if (quiz.current + 1 < quiz.questions.length) {
          feedbackKeyboard.inline_keyboard.push([{ text: '➡️ Next Question', callback_data: 'next_question' }]);
        } else {
          feedbackKeyboard.inline_keyboard.push([{ text: '🏁 Finish Quiz', callback_data: 'finish_quiz' }]);
        }

        await bot.editMessageText(
          `${formatQuestion(q, quiz.current + 1, quiz.questions.length)}\n\n${formatAnswer(q, answer)}\n\n⏱️ <i>Time Taken: ${timeTakenSec}s</i>`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: feedbackKeyboard
          }
        );
      } catch (editError) {
        console.error('Error editing message:', editError.message);
      }

      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('star_q_')) {
      const parts = data.split('_');
      const qIndex = parseInt(parts[2]);
      const quiz = activeQuizzes.get(chatId);

      if (!quiz) { bot.answerCallbackQuery(query.id, 'Quiz expired.'); return; }

      const q = quiz.questions[qIndex];
      const bookmarks = userBookmarks.get(chatId) || [];

      if (bookmarks.find(b => b.q.question === q.question)) {
        bot.answerCallbackQuery(query.id, 'Question already starred!', { show_alert: false });
        return;
      }

      bookmarks.push({ q, exam: quiz.exam, subject: quiz.subject, topic: quiz.topic });
      userBookmarks.set(chatId, bookmarks);
      saveBookmarks();

      bot.answerCallbackQuery(query.id, '⭐ Question added to your bookmarks!', { show_alert: false });
      return;
    }

    if (data === 'next_question' || data === 'finish_quiz') {
      const quiz = activeQuizzes.get(chatId);
      if (!quiz) { 
        bot.answerCallbackQuery(query.id, 'Test session expired. Please start a new one.'); 
        bot.sendMessage(chatId, '⚠️ <b>Your test session has expired.</b> Please start a new test from the main menu.', { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
        return; 
      }


      quiz.current++;

      if (data === 'next_question' && quiz.current < quiz.questions.length) {
        quiz.questionStartTime = Date.now();
        const nextQ = quiz.questions[quiz.current];
        bot.editMessageText(
          formatQuestion(nextQ, quiz.current + 1, quiz.questions.length),
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: getAnswerKeyboard()
          }
        );
      } else {
        // Quiz finished — Save Stats
        recordQuizStats(chatId, quiz.exam, quiz.subject, quiz.score, quiz.questions.length);
        // Note: Notion was already saved immediately after generation — no need to re-save here

        const pct = quiz.questions.length > 0 ? Math.round((quiz.score / quiz.questions.length) * 100) : 0;
        const grade = pct >= 80 ? '🏆 Outstanding!' : pct >= 60 ? '🎉 Good Job!' : pct >= 40 ? '💪 Keep Going!' : '📖 Needs Practice';
        const wrongCount = (quiz.wrongAnswers || []).length;
        const avgTime = quiz.questions.length > 0 ? Math.round((quiz.totalTime || 0) / quiz.questions.length) : 0;
        const speedRating = avgTime <= 45 ? '⚡ Excellent Speed' : avgTime <= 60 ? '🏃 Good Speed' : '🐢 Needs to be Faster';

        const summary = `
✅ <b>Test Complete!</b>

🏆 <b>Score:</b> ${quiz.score}/${quiz.questions.length}
📊 <b>Accuracy:</b> ${pct}%
❌ <b>Wrong:</b> ${wrongCount}
⏱️ <b>Avg Speed:</b> ${avgTime}s / question (${speedRating})

📂 <b>Topic:</b> ${quiz.topic}
📚 <b>Subject:</b> ${quiz.subject}
🎯 <b>Exam:</b> ${quiz.exam}
🤖 <b>AI Model:</b> <code>${escapeHTML(quiz.modelUsed || 'Auto')}</code>

${grade}

<i>All questions saved to Notion!</i>
`;

        const resultKeyboard = { inline_keyboard: [] };
        if (wrongCount > 0) resultKeyboard.inline_keyboard.push([{ text: `🔁 Review ${wrongCount} Wrong Answer(s)`, callback_data: 'review_wrong' }]);
        resultKeyboard.inline_keyboard.push([{ text: '📈 View My Stats', callback_data: 'view_stats' }]);
        resultKeyboard.inline_keyboard.push([{ text: '🏠 Main Menu', callback_data: 'main_menu' }]);

        if (wrongCount > 0) reviewSessions.set(chatId, { wrong: quiz.wrongAnswers, current: 0 });

        bot.editMessageText(summary, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: resultKeyboard
        });

        activeQuizzes.delete(chatId);
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    // AI Tutor Deep Dive Handler
    if (data.startsWith('deepdive_')) {
      const parts = data.split('_');
      const qIndex = parseInt(parts[1]);
      const answer = parts[2];
      const quiz = activeQuizzes.get(chatId);

      if (!quiz) { bot.answerCallbackQuery(query.id, 'Quiz expired or not active.'); return; }

      const q = quiz.questions[qIndex];
      const isCorrect = (answer === q.correctAnswer);

      bot.answerCallbackQuery(query.id, 'AI is analyzing your doubt...');

      bot.editMessageText(`🧠 <b>AI Tutor Deep Dive...</b>\n\nAnalyzing Question ${qIndex + 1}...\nPlease wait a few seconds.`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML'
      });

      try {
        const prompt = `You are an expert tutor named ExamVault Tutor.
The student answered a multiple choice question in their ${quiz.exam} exam prep (Subject: ${quiz.subject}, Topic: ${quiz.topic}).
Question: "${q.question}"
Options: A) ${q.optionA}, B) ${q.optionB}, C) ${q.optionC}, D) ${q.optionD}
Correct Answer was: ${q.correctAnswer}
The student chose: ${answer}. (${isCorrect ? 'They got it right but want deeper understanding.' : 'They got it wrong.'})

Write a DEEP DIVE explanation. Use NO markdown formatting like **bold** or ## headings, instead ONLY use EXACT HTML tags like <b>bold</b> and <i>italic</i> because Telegram requires it.
Include:
1. "ELI5": Explain it like they are 5 using a very simple real-world analogy.
2. Tell them exactly WHY ${answer} was wrong/right.
3. Give them a "Pro-Tip" or Mnemonic memory trick to never forget this concept.
Keep it strictly under 250 words, encouraging and clear!`;

        const targetModel = LAST_WORKING_GEMINI_MODEL || 'gemini-1.5-flash'; // fallback if no tests done yet
        const gRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${GEMINI_API_KEY}`, {


          contents: [{ parts: [{ text: prompt }] }]
        });

        const rawText = gRes.data.candidates[0].content.parts[0].text;
        
        // Escape HTML first then carefully re-enable b and i tags
        let htmlText = escapeHTML(rawText)
          .replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, '<b>$1</b>')
          .replace(/&lt;i&gt;(.*?)&lt;\/i&gt;/g, '<i>$1</i>')
          .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
          .replace(/\*(.*?)\*/g, '<i>$1</i>');

        const keyboard = { inline_keyboard: [] };
        if (quiz.current + 1 < quiz.questions.length) {
          keyboard.inline_keyboard.push([{ text: '➡️ Continue to Next Question', callback_data: 'next_question' }]);
        } else {
          keyboard.inline_keyboard.push([{ text: '🏁 Finish Quiz', callback_data: 'finish_quiz' }]);
        }

        bot.editMessageText(
          `💡 <b>ExamVault AI Tutor: Deep Dive</b>\n\n${htmlText}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: keyboard
          }
        );
      } catch (err) {
        console.error('Deep Dive Error:', err.message);
        const keyboard = { inline_keyboard: [] };
        if (quiz.current + 1 < quiz.questions.length) {
          keyboard.inline_keyboard.push([{ text: '➡️ Continue to Next Question', callback_data: 'next_question' }]);
        } else {
          keyboard.inline_keyboard.push([{ text: '🏁 Finish Quiz', callback_data: 'finish_quiz' }]);
        }
        bot.editMessageText(`⚠️ <b>AI Tutor Unavailable</b>\n\nSorry, I couldn't reach the AI Tutor right now. ${err.message}`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
      }

      return;
    }

    // Settings
    if (data === 'settings') {
      bot.editMessageText('⚙️ <b>Bot Settings</b>\n\nManage your API keys and configuration here:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: getSettingsKeyboard()
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Check Connections Diagnostic
    if (data === 'test_connections') {
      bot.editMessageText('🔍 <b>Running Live Connection Diagnostics...</b>\n\nTesting Gemini, Groq, OpenAI, and Notion. Please wait...', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });

      const liveStatus = await getLiveTokenStatus(true);
      await updatePinnedTokenStatus(chatId, true);

      let report = `🔍 <b>Live Connection & Token Health Report</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      report += `• 🔵 <b>Gemini AI:</b> ${liveStatus.gemini.details}\n`;
      report += `• 🟣 <b>Groq (Llama 3.3):</b> ${liveStatus.groq.details}\n`;
      report += `• 🟢 <b>OpenAI:</b> ${liveStatus.openai.details}\n`;
      report += `• 📂 <b>Notion Vault:</b> ${liveStatus.notion.details}\n\n`;
      report += `📌 <i>Your pinned status dashboard message has been updated!</i>`;

      bot.editMessageText(report, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: getSettingsKeyboard()
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'live_token_count' || data === 'refresh_live_tokens') {
      const text = formatLiveTokenCountMessage();
      const keyboard = {
        inline_keyboard: [
          [
            { text: '🔄 Refresh Count', callback_data: 'refresh_live_tokens' },
            { text: '🔍 Check Connections', callback_data: 'test_connections' }
          ],
          [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
        ]
      };
      
      if (query.message) {
        bot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: keyboard
        }).catch(() => {});
      } else {
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
      bot.answerCallbackQuery(query.id, { text: 'Live Token Count Refreshed!' });
      return;
    }

    if (data === 'main_menu') {
      bot.editMessageText('🎯 <b>Main Menu</b>', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: getMainKeyboard(chatId)
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Update Keys (Gemini, Groq, OpenAI, Notion, Bot Token)
    if (['update_gemini_key', 'update_groq_key', 'update_openai_key', 'update_notion_key', 'update_notion_id', 'update_bot_token'].includes(data)) {
      const labelMap = {
        'update_gemini_key': 'Gemini API Key',
        'update_groq_key': 'Groq API Key (starts with gsk_...)',
        'update_openai_key': 'OpenAI API Key',
        'update_notion_key': 'Notion API Key',
        'update_notion_id': 'Notion Parent ID',
        'update_bot_token': 'Telegram Bot Token'
      };
      topicInput.set(chatId, { step: data });
      bot.editMessageText(
        `🔑 Please reply with your new <b>${labelMap[data]}</b>:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML'
        }
      );
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Paster flow
    if (data === 'paster') {
      topicInput.set(chatId, { step: 1, mode: 'paster' });
      bot.editMessageText(
        `📋 <b>Paster Mode</b>\n\nThis feature allows you to paste your own text (from books, PDFs, or websites) and generate AI questions from it.\n\nFirst, select the <b>Exam</b> this text belongs to:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎖️ SSC', callback_data: 'exam_SSC' }],
              [{ text: '🚂 RRB', callback_data: 'exam_RRB' }],
              [{ text: '🏛️ TNPSC', callback_data: 'exam_TNPSC' }],
              [{ text: '🏦 Bank', callback_data: 'exam_Bank' }],
              [{ text: '⚙️ JE (Junior Engineer)', callback_data: 'exam_JE' }]
            ]
          }
        }
      );
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Schedule / Take Test
    if (data === 'schedule_test' || data === 'take_test') {
      const isSchedule = data === 'schedule_test';
      topicInput.set(chatId, { step: 1, mode: isSchedule ? 'schedule' : 'take_now' });
      bot.editMessageText(
        `Select the <b>Exam</b> you are preparing for:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎖️ SSC', callback_data: 'exam_SSC' }],
              [{ text: '🚂 RRB', callback_data: 'exam_RRB' }],
              [{ text: '🏛️ TNPSC', callback_data: 'exam_TNPSC' }],
              [{ text: '🏦 Bank', callback_data: 'exam_Bank' }],
              [{ text: '⚙️ JE (Junior Engineer)', callback_data: 'exam_JE' }]
            ]
          }
        }
      );
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Exam selection
    if (data.startsWith('exam_')) {
      const exam = data.split('_')[1];
      const input = topicInput.get(chatId);
      if (!input) return;

      input.exam = exam;
      input.step = 2; // Move to Subject Selection step

      bot.editMessageText(`Selected Exam: <b>${exam}</b>\n\nNow, select a <b>Subject</b>:`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: getSubjectKeyboard(exam)
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Subject selection
    if (data.startsWith('subj_')) {
      const index = parseInt(data.split('_')[1]);
      const input = topicInput.get(chatId);
      if (!input || !input.exam) return;

      const subject = EXAM_SUBJECTS[input.exam][index];
      input.subject = subject;

      if (input.exam === 'Bank') {
        const topics = BANK_TOPICS[subject] || [];
        const keyboard = [];
        for (let i = 0; i < topics.length; i += 2) {
          const row = [{ text: topics[i], callback_data: `btop_${i}` }];
          if (topics[i + 1]) row.push({ text: topics[i + 1], callback_data: `btop_${i + 1}` });
          keyboard.push(row);
        }

        bot.editMessageText(`Selected Subject: <b>${subject}</b>\n\nNow, select the <b>Topic</b>:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      } else {
        input.step = 3; // Move to Topic Input step (via message)
        bot.editMessageText(`Selected Subject: <b>${subject}</b>\n\nNow, please type and send the specific <b>Topic</b> you want to generate questions for:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML'
        });
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Bank Topic selection (Inline Keyboard)
    if (data.startsWith('btop_')) {
      const index = parseInt(data.split('_')[1]);
      const input = topicInput.get(chatId);
      if (!input || !input.subject || input.exam !== 'Bank') return;

      const topics = BANK_TOPICS[input.subject] || [];
      const topic = topics[index];
      input.topic = topic;

      if (input.mode === 'paster') {
        input.step = 'paster_text';
        bot.editMessageText(`Selected Topic: <b>${escapeHTML(topic)}</b>\n\nNow, please <b>PASTE the Text/Content</b> you want to generate questions from:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML'
        }).catch(() => {
          bot.sendMessage(chatId, `Selected Topic: <b>${escapeHTML(topic)}</b>\n\nNow, please <b>PASTE the Text/Content</b> you want to generate questions from:`, { parse_mode: 'HTML' });
        });
        bot.answerCallbackQuery(query.id);
        return;
      }


      input.step = 4; // Move directly to ask questions count step

      const isBankSetBased = isBankSetBasedHelper(input.exam, input.topic);

      if (isBankSetBased) {
        bot.editMessageText(`Selected Topic: <b>${topic}</b>\n\nThis is a <b>Set-based topic</b>.\nHow many <b>Sets</b> do you want to generate? (1 Set = 1 Context + 5 Questions).\nPlease enter the number of Sets (e.g., 1, 2, 3).\n(Default: 2 sets = 10 questions)`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML'
        });
      } else {
        bot.editMessageText(`Selected Topic: <b>${topic}</b>\n\nHow many <b>Questions</b> would you like to generate? (e.g., 5, 10, 20)\n<i>(Default: 10 if you type anything else)</i>`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML'
        });
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    // View schedule
    if (data === 'view_schedule') {
      const schedule = userSchedules.get(chatId);

      if (!schedule) {
        bot.answerCallbackQuery(query.id, 'No scheduled tests');
        return;
      }

      const scheduled = new Date(schedule.scheduledFor);
      const text = `
📅 <b>Your Current Schedule</b>

📂 <b>Topic:</b> ${escapeHTML(schedule.topic)}
📚 <b>Subject:</b> ${escapeHTML(schedule.subject)}
🏛️ <b>Exam:</b> ${escapeHTML(schedule.exam)}
🔢 <b>Questions:</b> ${schedule.count || 10}

⏰ <b>Scheduled for:</b>
${scheduled.toLocaleDateString()} at ${scheduled.toLocaleTimeString()}

Status: <b>${schedule.status.toUpperCase()}</b>
`;
      const keyboard = {
        inline_keyboard: [
          [
            { text: '🕒 Change Time Only', callback_data: 'edit_time_only' },
            { text: '✏️ Reschedule All', callback_data: 'schedule_test' }
          ],
          [
            { text: '🗑️ Delete Schedule', callback_data: 'delete_schedule' },
            { text: '🔙 Back to Menu', callback_data: 'main_menu' }
          ]
        ]
      };

      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: keyboard
      }).catch(() => {
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
      });

      bot.answerCallbackQuery(query.id);
      return;
    }


    if (data === 'delete_schedule') {
      userSchedules.delete(chatId);
      saveSchedules();
      const text = '🗑️ <b>Schedule deleted successfully.</b>\n\nYou can now schedule a new test whenever you want.';
      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: getMainKeyboard(chatId)
      }).catch(() => {
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId) });
      });
      bot.answerCallbackQuery(query.id, 'Schedule deleted');
      return;
    }

    if (data === 'edit_time_only') {
      const schedule = userSchedules.get(chatId);
      if (!schedule) {
        bot.answerCallbackQuery(query.id, 'No active schedule.');
        return;
      }

      topicInput.set(chatId, {
        step: 5,
        mode: 'schedule',
        exam: schedule.exam,
        subject: schedule.subject,
        topic: schedule.topic,
        count: schedule.count
      });

      bot.editMessageText(`🕒 <b>Editing Schedule Time</b>\n\nTopic: ${escapeHTML(schedule.topic)}\n\nPlease enter the new <b>Time</b> (24h format, e.g. 07:00, 15:30):`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {
        bot.sendMessage(chatId, `🕒 <b>Editing Schedule Time</b>\n\nPlease enter the new <b>Time</b> (24h format, e.g. 07:00, 15:30):`, { parse_mode: 'HTML' });
      });
      bot.answerCallbackQuery(query.id);
      return;
    }



    // Cancel Generation
    if (data === 'cancel_generation') {
      const input = topicInput.get(chatId);
      if (input) {
        input.cancelled = true;
        bot.editMessageText('🚫 <b>Generation Cancelled.</b>', {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: getMainKeyboard(chatId)
        });
      }
      bot.answerCallbackQuery(query.id, 'Generation stopped.');
      return;
    }

    // ==================== STATS ====================
    if (data === 'view_stats') {
      const statsMsg = formatStatsMessage(chatId);
      bot.editMessageText(statsMsg, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'main_menu' }]] }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // ==================== BOOKMARKS ====================
    if (data === 'view_bookmarks') {
      const bookmarks = userBookmarks.get(chatId) || [];
      if (bookmarks.length === 0) {
        bot.answerCallbackQuery(query.id, 'You have no starred questions yet!', { show_alert: true });
        return;
      }

      // Start review of bookmarks
      reviewSessions.set(chatId, { mode: 'bookmarks', items: bookmarks, current: 0 });
      showBookmarkItem(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    // ==================== ADMIN PANEL CALLBACKS ====================

    if (data === 'admin_panel') {
      if (!isAdmin(chatId)) return;
      showAdminPanel(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_users') {
      if (!isAdmin(chatId)) return;
      showUserManagement(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_user_info_')) {
      if (!isAdmin(chatId)) return;
      const targetId = parseInt(data.replace('admin_user_info_', ''));
      const text = `👤 <b>User Details: ${targetId}</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
        `Admin Status: ${targetId === ADMIN_ID ? '✅ YES' : '❌ NO'}\n` +
        `Has Stats: ${userStats.has(targetId) ? '✅ YES' : '❌ NO'}\n` +
        `Has Bookmarks: ${userBookmarks.has(targetId) ? '✅ YES' : '❌ NO'}\n\n` +
        `What would you like to do?`;

      const keyboard = {
        inline_keyboard: [
          targetId !== ADMIN_ID ? [{ text: '🗑️ Delete User', callback_data: `admin_delete_user_${targetId}` }] : [],
          [{ text: '🔙 Back to Users', callback_data: 'admin_manage_users' }]
        ].filter(r => r.length > 0)
      };

      bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: keyboard }).catch(() => { });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_delete_user_')) {
      if (!isAdmin(chatId)) return;
      const targetId = parseInt(data.replace('admin_delete_user_', ''));

      if (targetId === ADMIN_ID) {
        bot.answerCallbackQuery(query.id, 'Cannot delete admin!', { show_alert: true });
        return;
      }

      allUsers.delete(targetId);
      saveUsers();
      bot.answerCallbackQuery(query.id, `User ${targetId} deleted.`);
      showUserManagement(chatId, query.message.message_id);
      return;
    }

    if (data === 'admin_broadcast') {
      if (!isAdmin(chatId)) return;
      topicInput.set(chatId, { step: 'admin_broadcast_input' });
      bot.editMessageText('📢 <b>Global Broadcast</b>\n━━━━━━━━━━━━━━━━━━━━\nPlease type and send the message you want to broadcast to <b>ALL</b> users:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'bm_next') {
      const session = reviewSessions.get(chatId);
      if (!session || session.mode !== 'bookmarks') { bot.answerCallbackQuery(query.id); return; }
      session.current++;
      if (session.current >= session.items.length) {
        bot.editMessageText('🔖 <b>End of Bookmarks</b>\n\nYou have reviewed all your starred questions.', {
          chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] }
        });
        reviewSessions.delete(chatId);
      } else {
        showBookmarkItem(chatId, query.message.message_id);
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'bm_delete') {
      const session = reviewSessions.get(chatId);
      if (!session || session.mode !== 'bookmarks') { bot.answerCallbackQuery(query.id); return; }

      const bookmarks = userBookmarks.get(chatId) || [];
      bookmarks.splice(session.current, 1);
      userBookmarks.set(chatId, bookmarks);
      saveBookmarks();

      bot.answerCallbackQuery(query.id, '🗑️ Removed from bookmarks.');

      if (bookmarks.length === 0) {
        bot.editMessageText('🔖 <b>No more bookmarks.</b>', {
          chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] }
        });
        reviewSessions.delete(chatId);
      } else {
        if (session.current >= bookmarks.length) session.current = bookmarks.length - 1;
        session.items = bookmarks;
        showBookmarkItem(chatId, query.message.message_id);
      }
      return;
    }

    // ==================== /stats command ====================
    // (also handled via onText below)

    // ==================== WRONG ANSWER REVIEW ====================
    if (data === 'review_wrong') {
      const session = reviewSessions.get(chatId);
      if (!session || session.wrong.length === 0) {
        bot.answerCallbackQuery(query.id, 'No wrong answers to review!');
        return;
      }
      session.current = 0;
      const { q, userAnswer } = session.wrong[0];
      const total = session.wrong.length;
      bot.editMessageText(
        `🔁 <b>Wrong Answer Review</b> — ${1}/${total}\n\n` +
        `<b>${escapeHTML(q.question)}</b>\n\n` +
        `<b>A)</b> ${escapeHTML(q.optionA)}\n<b>B)</b> ${escapeHTML(q.optionB)}\n<b>C)</b> ${escapeHTML(q.optionC)}\n<b>D)</b> ${escapeHTML(q.optionD)}\n\n` +
        `❌ <b>Your Answer:</b> ${escapeHTML(userAnswer)}\n` +
        `✅ <b>Correct Answer:</b> ${escapeHTML(q.correctAnswer)}\n\n` +
        `📖 <b>Explanation:</b>\n${escapeHTML(q.explanation || 'N/A')}`,

        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              total > 1 ? [{ text: '➡️ Next Wrong Answer', callback_data: 'review_next' }] : [],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ].filter(r => r.length > 0)
          }
        }
      );
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'review_next') {
      const session = reviewSessions.get(chatId);
      if (!session) { bot.answerCallbackQuery(query.id); return; }
      session.current++;
      if (session.current >= session.wrong.length) {
        bot.editMessageText('✅ <b>Review Complete!</b>\n\nYou have reviewed all wrong answers. Keep practising!', {
          chat_id: chatId, message_id: query.message.message_id,
          parse_mode: 'HTML', reply_markup: getMainKeyboard(chatId)
        });
        reviewSessions.delete(chatId);
        bot.answerCallbackQuery(query.id);
        return;
      }
      const { q, userAnswer } = session.wrong[session.current];
      const total = session.wrong.length;
      const idx = session.current;
      bot.editMessageText(
        `🔁 <b>Wrong Answer Review</b> — ${idx + 1}/${total}\n\n` +
        `<b>${escapeHTML(q.question)}</b>\n\n` +
        `<b>A)</b> ${escapeHTML(q.optionA)}\n<b>B)</b> ${escapeHTML(q.optionB)}\n<b>C)</b> ${escapeHTML(q.optionC)}\n<b>D)</b> ${escapeHTML(q.optionD)}\n\n` +
        `❌ <b>Your Answer:</b> ${escapeHTML(userAnswer)}\n` +
        `✅ <b>Correct Answer:</b> ${escapeHTML(q.correctAnswer)}\n\n` +
        `📖 <b>Explanation:</b>\n${escapeHTML(q.explanation || 'N/A')}`,

        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              idx + 1 < total ? [{ text: '➡️ Next Wrong Answer', callback_data: 'review_next' }] : [],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ].filter(r => r.length > 0)
          }
        }
      );
      bot.answerCallbackQuery(query.id);
      return;
    }

    // ==================== QUICK PRACTICE ====================
    if (data === 'quick_practice') {
      bot.editMessageText('⚡ <b>Quick Practice</b>\n\nInstant 5-question drill! Select an exam:', {
        chat_id: chatId, message_id: query.message.message_id,
        parse_mode: 'HTML', reply_markup: getQuickExamKeyboard()
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('qp_exam_')) {
      const exam = data.replace('qp_exam_', '');
      topicInput.set(chatId, { exam, mode: 'quick', step: 'qp_subject' });
      bot.editMessageText(`⚡ <b>Quick Practice</b> — ${exam}\n\nPick a subject (or Random):`, {
        chat_id: chatId, message_id: query.message.message_id,
        parse_mode: 'HTML', reply_markup: getQuickSubjectKeyboard(exam)
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('qp_subj_') || data === 'qp_subj_random') {
      const input = topicInput.get(chatId);
      if (!input || !input.exam) { bot.answerCallbackQuery(query.id); return; }

      const subjects = EXAM_SUBJECTS[input.exam] || [];
      let subject;
      if (data === 'qp_subj_random') {
        subject = subjects[Math.floor(Math.random() * subjects.length)];
      } else {
        const idx = parseInt(data.replace('qp_subj_', ''));
        subject = subjects[idx];
      }

      // Use subject name as the topic for quick practice
      const topic = subject;
      topicInput.delete(chatId);

      bot.editMessageText(`⚡ <b>Quick Practice</b>\n📚 ${subject} — ${input.exam}\n\n🌟 <b>Generating 5 questions instantly...</b>`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML'
      });

      const result = await generateQuestionsWithAnimation(chatId, topic, input.exam, subject, 5);
      if (!result) return;
      const { questions, modelUsed } = result;

      activeQuizzes.set(chatId, {
        questions, current: 0, score: 0,
        topic, subject, exam: input.exam, modelUsed, wrongAnswers: [],
        questionStartTime: Date.now(), totalTime: 0
      });
      bot.sendMessage(chatId, formatQuestion(questions[0], 1, questions.length), {
        parse_mode: 'HTML', reply_markup: getAnswerKeyboard()
      });

      bot.answerCallbackQuery(query.id);
      return;
    }

    // ==================== PRACTICE WEAK AREA ====================
    if (data === 'practice_weak') {
      const s = userStats.get(chatId);
      if (!s || s.totalTests === 0) {
        bot.answerCallbackQuery(query.id, 'Take at least 1 test first to find your weak area!', { show_alert: true });
        return;
      }

      let weakestSubj = null, weakestAcc = 101, weakestExam = null;
      for (const [exam, ed] of Object.entries(s.byExam)) {
        for (const [subj, d] of Object.entries(ed.bySubject)) {
          const a = d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0;
          if (a < weakestAcc) { weakestAcc = a; weakestSubj = subj; weakestExam = exam; }
        }
      }

      if (!weakestSubj) {
        bot.answerCallbackQuery(query.id, 'Not enough data to find weak areas yet.', { show_alert: true });
        return;
      }

      bot.editMessageText(`🎯 <b>Targeted Weak Area Practice</b>\n\nYour weakest subject is <b>${weakestSubj}</b> (${weakestAcc}%) in ${weakestExam}.\n\n🌟 Generating 5 specialized redemption questions instantly...`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML'
      });

      const topic = weakestSubj;
      const result = await generateQuestionsWithAnimation(chatId, topic, weakestExam, weakestSubj, 5);
      if (!result) return;
      const { questions, modelUsed } = result;

      activeQuizzes.set(chatId, {
        questions, current: 0, score: 0,
        topic, subject: weakestSubj, exam: weakestExam, modelUsed, wrongAnswers: [],
        questionStartTime: Date.now(), totalTime: 0
      });
      bot.sendMessage(chatId, formatQuestion(questions[0], 1, questions.length), {
        parse_mode: 'HTML', reply_markup: getAnswerKeyboard()
      });

      bot.answerCallbackQuery(query.id);
      return;
    }


    // ==================== NEW FEATURE CALLBACKS ====================

    // AI Tutor Callbacks
    if (data === 'ai_tutor_start') {
      activeTutorSessions.set(chatId, { active: true, startTime: Date.now() });
      const text = `🤖 <b>ExamVault AI Tutor Mode Activated!</b>\n━━━━━━━━━━━━━━━━━━━━\nI am your dedicated 24/7 AI tutor for <b>SSC, RRB, TNPSC, Banking & JE Exams</b>.\n\nAsk me any doubt or question directly in the chat below!\n\n<i>Type <code>/exit</code> or click below anytime to exit.</i>`;
      bot.editMessageText(text, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🚪 Exit Tutor Mode', callback_data: 'exit_tutor' }]] }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'exit_tutor') {
      activeTutorSessions.delete(chatId);
      bot.editMessageText('🚪 <b>Exited AI Tutor Mode.</b> Back to Main Menu!', {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
        reply_markup: getMainKeyboard(chatId)
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // AI Syllabus Mapper Callbacks
    if (data === 'syllabus_menu') {
      bot.editMessageText(`🗺️ <b>AI Syllabus Mapper</b>\n━━━━━━━━━━━━━━━━━━━━\nSelect an exam to view your syllabus coverage:`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎖️ SSC', callback_data: 'syl_SSC' }, { text: '🚂 RRB', callback_data: 'syl_RRB' }],
            [{ text: '🏛️ TNPSC', callback_data: 'syl_TNPSC' }, { text: '🏦 Bank', callback_data: 'syl_Bank' }],
            [{ text: '⚙️ JE', callback_data: 'syl_JE' }],
            [{ text: '🔙 Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('syl_')) {
      const exam = data.replace('syl_', '');
      showSyllabusMap(chatId, exam, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Current Affairs Callback
    if (data === 'current_affairs_start') {
      bot.editMessageText('📰 <b>Generating Current Affairs 2025-2026 Digest...</b>\n\n🌟 Preparing 5 fresh MCQs...', {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML'
      });
      const result = await generateQuestionsWithAnimation(chatId, 'Current Affairs 2025-2026', 'SSC', 'Current Affairs', 5);
      if (!result) return;
      const { questions, modelUsed } = result;
      activeQuizzes.set(chatId, {
        questions, current: 0, score: 0,
        topic: 'Current Affairs 2025-2026', subject: 'Current Affairs', exam: 'SSC', modelUsed, wrongAnswers: [],
        questionStartTime: Date.now(), totalTime: 0
      });
      bot.sendMessage(chatId, formatQuestion(questions[0], 1, questions.length), {
        parse_mode: 'HTML', reply_markup: getAnswerKeyboard()
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Flashcard Callbacks
    if (data === 'flashcards_menu') {
      showFlashcardMenu(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'gen_flashcards_select') {
      bot.editMessageText(`🗃️ <b>Generate AI Flashcards</b>\n━━━━━━━━━━━━━━━━━━━━\nSelect an Exam:`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎖️ SSC (General Awareness)', callback_data: 'gen_fc_SSC_General Knowledge' }],
            [{ text: '🚂 RRB (Science & Tech)', callback_data: 'gen_fc_RRB_Science' }],
            [{ text: '🏛️ TNPSC (Tamil Culture & History)', callback_data: 'gen_fc_TNPSC_History and Culture' }],
            [{ text: '🏦 Bank (Financial Awareness)', callback_data: 'gen_fc_Bank_General Awareness' }],
            [{ text: '⚙️ JE (Engineering Formulas)', callback_data: 'gen_fc_JE_Thermodynamics' }],
            [{ text: '🔙 Back', callback_data: 'flashcards_menu' }]
          ]
        }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('gen_fc_')) {
      const parts = data.replace('gen_fc_', '').split('_');
      const exam = parts[0];
      const subject = parts[1] || 'General Knowledge';
      generateFlashcards(chatId, exam, subject, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'review_flashcards') {
      const cards = userFlashcards.get(chatId) || [];
      if (cards.length === 0) {
        bot.answerCallbackQuery(query.id, 'No flashcards saved yet!', { show_alert: true });
        return;
      }
      activeFlashcardSessions.set(chatId, { cards, current: 0, showingAnswer: false });
      renderFlashcard(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'fc_reveal') {
      const session = activeFlashcardSessions.get(chatId);
      if (session) {
        session.showingAnswer = true;
        renderFlashcard(chatId, query.message.message_id);
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'fc_know' || data === 'fc_again') {
      const session = activeFlashcardSessions.get(chatId);
      if (session) {
        session.current++;
        session.showingAnswer = false;
        if (session.current >= session.cards.length) {
          bot.editMessageText('🎉 <b>Flashcard Review Complete!</b>\n\nYou have reviewed all flashcards in this deck.', {
            chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
            reply_markup: getMainKeyboard(chatId)
          });
          activeFlashcardSessions.delete(chatId);
        } else {
          renderFlashcard(chatId, query.message.message_id);
        }
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Exam Countdown Callbacks
    if (data === 'countdown_menu') {
      showCountdownDashboard(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'set_countdown_exam') {
      bot.editMessageText(`📆 <b>Set Target Exam Date</b>\n━━━━━━━━━━━━━━━━━━━━\nSelect your target exam:`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎖️ SSC', callback_data: 'set_cd_exam_SSC' }, { text: '🚂 RRB', callback_data: 'set_cd_exam_RRB' }],
            [{ text: '🏛️ TNPSC', callback_data: 'set_cd_exam_TNPSC' }, { text: '🏦 Bank', callback_data: 'set_cd_exam_Bank' }],
            [{ text: '⚙️ JE', callback_data: 'set_cd_exam_JE' }],
            [{ text: '🔙 Back', callback_data: 'countdown_menu' }]
          ]
        }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('set_cd_exam_')) {
      const exam = data.replace('set_cd_exam_', '');
      topicInput.set(chatId, { step: 'set_countdown_date', exam });
      bot.editMessageText(`📆 <b>Target Exam: ${exam}</b>\n\nPlease type and send your target exam date in <code>YYYY-MM-DD</code> format (e.g., <code>2026-11-20</code>):`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML'
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('take_countdown_quiz_')) {
      const parts = data.replace('take_countdown_quiz_', '').split('_');
      const count = parseInt(parts[0]) || 10;
      const exam = parts[1] || 'SSC';
      bot.editMessageText(`🎯 <b>Daily Target Quiz (${count} Qs - ${exam})</b>\n\n🌟 Generating your recommended quota...`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML'
      });
      const result = await generateQuestionsWithAnimation(chatId, 'Daily Target Quota', exam, 'General Knowledge', count);
      if (!result) return;
      const { questions, modelUsed } = result;
      activeQuizzes.set(chatId, {
        questions, current: 0, score: 0,
        topic: 'Daily Target Quota', subject: 'General Knowledge', exam, modelUsed, wrongAnswers: [],
        questionStartTime: Date.now(), totalTime: 0
      });
      bot.sendMessage(chatId, formatQuestion(questions[0], 1, questions.length), {
        parse_mode: 'HTML', reply_markup: getAnswerKeyboard()
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Mock Exam & PYQ Callbacks
    if (data === 'mock_exam_menu') {
      showMockExamMenu(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'pyq_menu') {
      showPyqMenu(chatId, query.message.message_id);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('start_mock_')) {
      const parts = data.replace('start_mock_', '').split('_');
      const exam = parts[0];
      const count = parseInt(parts[1]) || 25;
      startMockOrPyqSession(chatId, exam, count, `${exam} Full-Length Mock Exam`, false);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('start_pyq_')) {
      const parts = data.replace('start_pyq_', '').split('_');
      const exam = parts[0];
      const year = parts[1] || '2023';
      startMockOrPyqSession(chatId, exam, 25, `${exam} ${year} Official PYQ Paper`, true);
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('mock_ans_')) {
      const session = activeMockExams.get(chatId);
      if (!session) {
        bot.answerCallbackQuery(query.id, 'Mock exam session expired.');
        return;
      }
      const choice = data.replace('mock_ans_', '');
      session.userAnswers[session.current] = choice === 'SKIP' ? null : choice;
      session.current++;

      if (session.current < session.questions.length) {
        renderMockQuestion(chatId, query.message.message_id);
      } else {
        finishMockExam(chatId, query.message.message_id);
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    // Web Dashboard info Callback
    if (data === 'web_dashboard_info') {
      const port = process.env.PORT || 10000;
      const text = `🌐 <b>ExamVault Companion Web Dashboard</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
        `Access your live visual telemetry dashboard on any web browser!\n\n` +
        `• <b>Dashboard URL:</b> <code>http://localhost:${port}/</code>\n` +
        `• <b>JSON Stats API:</b> <code>http://localhost:${port}/api/stats</code>\n\n` +
        `<i>View user metrics, total token counts, engine polling status, and exam statistics live!</i>`;

      bot.editMessageText(text, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main_menu' }]] }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }

    // End of callback_query
    bot.answerCallbackQuery(query.id);
  } catch (globalError) {
    console.error('CRITICAL Callback Handler Error:', globalError);
    bot.answerCallbackQuery(query.id, 'Error occurred in bot handler.');
  }
});

// ==================== SCHEDULED TASKS ====================

/**
 * Run every minute to check for scheduled tests
 */
cron.schedule('* * * * *', async () => {
  const now = new Date();

  for (const [chatId, schedule] of userSchedules.entries()) {
    const scheduledTime = new Date(schedule.scheduledFor);

    // Check if it's time (now is past the scheduled time)
    if (now >= scheduledTime && schedule.status === 'scheduled') {
      console.log(`🚀 Triggering scheduled test for user ${chatId}: ${schedule.topic}`);

      schedule.status = 'running';
      saveSchedules(); // Update status in file

      // Generate questions with animated luminance UI
      const result = await generateQuestionsWithAnimation(
        chatId,
        schedule.topic,
        schedule.exam,
        schedule.subject,
        schedule.count || 10
      );

      if (!result || !result.questions || result.questions.length === 0) {
        // schedule was reassigned or failed
        schedule.status = 'scheduled'; // Allow retry
        saveSchedules();
        continue;
      }

      const { questions, modelUsed } = result;
      schedule.status = 'completed';
      saveSchedules();

      // Notion was already saved inside generateQuestionsWithAnimation
      activeQuizzes.set(chatId, {
        questions,
        current: 0,
        score: 0,
        topic: schedule.topic,
        subject: schedule.subject,
        exam: schedule.exam,
        modelUsed
      });

      const firstQ = questions[0];
      bot.sendMessage(
        chatId,
        formatQuestion(firstQ, 1, questions.length),
        {
          parse_mode: 'HTML',
          reply_markup: getAnswerKeyboard()
        }
      );
    }
  }
});

/**
 * 🔔 DAILY REMINDER: 9:00 PM
 * Nudge users who forget to schedule their test for tomorrow.
 */
cron.schedule('0 21 * * *', async () => {
  console.log('🔔 Checking for users who forgot to schedule their tests...');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  for (const chatId of allUsers) {
    const schedule = userSchedules.get(chatId);

    // If no schedule OR schedule is in the past OR not for tomorrow
    let hasTomorrowTest = false;
    if (schedule && schedule.status === 'scheduled') {
      const scheduledDate = new Date(schedule.scheduledFor);
      if (scheduledDate.toDateString() === tomorrow.toDateString()) {
        hasTomorrowTest = true;
      }
    }

    if (!hasTomorrowTest) {
      try {
        const reminderText = `
🔔 <b>Friendly Reminder: ExamVault</b>
━━━━━━━━━━━━━━━━━━━━
🌟 You haven't scheduled a test for tomorrow yet!

Consistent practice is the key to success. Take a moment to set your topic for tomorrow's 7 AM challenge.

🎯 <b>Prepare for your goal now:</b>
`;
        await bot.sendMessage(chatId, reminderText, {
          parse_mode: 'HTML',
          reply_markup: getMainKeyboard(chatId)
        });
        console.log(`Sent reminder to user ${chatId}`);
      } catch (err) {
        console.error(`Failed to send reminder to ${chatId}:`, err.message);
      }
    }
  }
});

/**
 * 📌 LIVE TOKEN DASHBOARD CRON (Every 30 mins)
 * Automatically refresh live model quota & status for all active users.
 */
cron.schedule('*/30 * * * *', async () => {
  console.log('📌 Refreshing live token & model status dashboard...');
  const status = await getLiveTokenStatus(true);
  for (const chatId of allUsers) {
    if (pinnedMessagesMap.has(chatId)) {
      await updatePinnedTokenStatus(chatId);
    }
  }
});


// ==================== ERROR HANDLING ====================

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

console.log('🤖 ExamVault Advanced Bot is running...');
console.log('⏰ Monitoring for scheduled tests...');

// HTTP Health & Web Dashboard Server (Feature 75)
const PORT = process.env.PORT || 10000;
http.createServer(async (req, res) => {
  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const liveStatus = await getLiveTokenStatus();
    return res.end(JSON.stringify({
      users: allUsers.size,
      stats: globalTokenStats,
      status: liveStatus
    }));
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ExamVault AI Bot — Web Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(255, 255, 255, 0.04);
      --border: rgba(255, 255, 255, 0.08);
      --accent: #6366f1;
      --text: #f3f4f6;
      --muted: #9ca3af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Outfit', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 2rem; min-height: 100vh; }
    .header { text-align: center; margin-bottom: 2.5rem; }
    .header h1 { font-size: 2.5rem; font-weight: 700; background: linear-gradient(135deg, #a5b4fc, #6366f1, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .header p { color: var(--muted); margin-top: 0.5rem; font-size: 1.1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; max-width: 1200px; margin: 0 auto; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 16px; padding: 1.5rem; backdrop-filter: blur(12px); box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37); transition: transform 0.2s, border-color 0.2s; }
    .card:hover { transform: translateY(-4px); border-color: var(--accent); }
    .card-title { font-size: 0.9rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 0.5rem; }
    .card-value { font-size: 2.2rem; font-weight: 700; color: #fff; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.85rem; font-weight: 600; background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .status-list { list-style: none; margin-top: 1rem; }
    .status-list li { display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.95rem; }
    .commands-box { background: rgba(0,0,0,0.3); border-radius: 12px; padding: 1rem; font-family: monospace; color: #a5b4fc; font-size: 0.85rem; line-height: 1.6; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚡ ExamVault Companion Web Dashboard</h1>
    <p>Live AI Engine Telemetry & Performance Dashboard</p>
  </div>
  <div class="grid">
    <div class="card">
      <div class="card-title">Bot Health & Engine</div>
      <div class="card-value"><span class="badge">🟢 ONLINE & POLLING</span></div>
      <ul class="status-list">
        <li><span>Registered Users</span><b>${allUsers.size} Users</b></li>
        <li><span>Active Schedules</span><b>${userSchedules.size}</b></li>
        <li><span>Bookmarked Qs</span><b>${userBookmarks.size}</b></li>
        <li><span>Exam Date Goals</span><b>${userExamDates.size}</b></li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title">Token Usage Telemetry</div>
      <div class="card-value">${globalTokenStats.totalTokens.toLocaleString()}</div>
      <ul class="status-list">
        <li><span>Total AI API Requests</span><b>${globalTokenStats.totalRequests} calls</b></li>
        <li><span>Prompt Tokens</span><b>${globalTokenStats.totalPromptTokens.toLocaleString()}</b></li>
        <li><span>Completion Tokens</span><b>${globalTokenStats.totalCompletionTokens.toLocaleString()}</b></li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title">Supported Exams</div>
      <div class="card-value" style="font-size:1.4rem;">5 Core Categories</div>
      <ul class="status-list">
        <li><span>🎖️ SSC Exams</span><b>CGL, CHSL, MTS</b></li>
        <li><span>🚂 Railway Exams</span><b>RRB NTPC, Group D</b></li>
        <li><span>🏛️ TNPSC</span><b>Group 1, 2, 4</b></li>
        <li><span>🏦 Banking</span><b>IBPS, SBI PO</b></li>
        <li><span>⚙️ Engineering</span><b>RRB JE, SSC JE</b></li>
      </ul>
    </div>
  </div>
  <div style="max-width:1200px; margin: 2rem auto 0 auto;">
    <div class="card">
      <div class="card-title">Telegram Bot Quick Reference Commands</div>
      <div class="commands-box">
        /mock - Start a full-length timed mock exam<br>
        /pyq - Practice official Previous Year Papers<br>
        /tutor [query] - Enter 24/7 AI tutor mode<br>
        /syllabus [exam] - View AI syllabus coverage & gap map<br>
        /currentaffairs - Instant Current Affairs 2025-2026 digest<br>
        /flashcard - Revision flashcards<br>
        /countdown - Exam target countdown & daily quota<br>
        /stats - Performance dashboard
      </div>
    </div>
  </div>
</body>
</html>`;
  res.end(html);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health & Web Dashboard server listening on port ${PORT}`);
});

// Graceful shutdown to prevent "409 Conflict" on Telegram for Render (Zero-Downtime Deploy)
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server and stopping bot polling');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: stopping bot polling');
  bot.stopPolling();
  process.exit(0);
});
