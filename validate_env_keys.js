#!/usr/bin/env node

/**
 * ============================================================
 *  EXAMVAULT — .ENV KEY VALIDATOR & WATCHER
 * ============================================================
 *  - Watches the .env file for ANY save/change
 *  - Detects which API keys changed
 *  - Tests each changed key live against its API
 *  - If VALID   → keeps the key saved in .env ✅
 *  - If INVALID → reverts to old value & explains why ❌
 *  - Works standalone: node validate_env_keys.js
 * ============================================================
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ENV_PATH = path.resolve(__dirname, '.env');

// ─── ANSI Colors ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  bgRed:  '\x1b[41m',
  bgGreen:'\x1b[42m',
};

const ok   = (msg) => console.log(`${C.green}${C.bold}  ✅  ${msg}${C.reset}`);
const fail = (msg) => console.log(`${C.red}${C.bold}  ❌  ${msg}${C.reset}`);
const warn = (msg) => console.log(`${C.yellow}${C.bold}  ⚠️   ${msg}${C.reset}`);
const info = (msg) => console.log(`${C.cyan}  ℹ️   ${msg}${C.reset}`);
const head = (msg) => console.log(`\n${C.blue}${C.bold}${msg}${C.reset}`);
const dim  = (msg) => console.log(`${C.dim}  ${msg}${C.reset}`);
const hr   = ()    => console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`);

// ─── Parse .env file ──────────────────────────────────────────────────────────
function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

// ─── Write a single key back to .env ─────────────────────────────────────────
function writeKeyToEnv(key, value) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*`, 'm');
  if (content.match(regex)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}`;
  }
  fs.writeFileSync(ENV_PATH, content.trimEnd() + '\n', 'utf8');
}

// ─── Simple HTTP POST helper (no external deps) ───────────────────────────────
function httpPost(hostname, path, headers, body, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// ─── VALIDATORS ───────────────────────────────────────────────────────────────

/** Validate Gemini API Key — tries multiple models */
async function validateGemini(key) {
  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-1.0-pro',
  ];

  let lastErr = null;
  let quotaHit = false;

  for (const model of models) {
    try {
      const res = await httpPost(
        'generativelanguage.googleapis.com',
        `/v1beta/models/${model}:generateContent?key=${key}`,
        {},
        { contents: [{ parts: [{ text: 'hi' }] }] }
      );

      if (res.status === 200 && res.data.candidates) {
        return { valid: true, detail: `Working model: ${model}`, model };
      }

      if (res.status === 429 || res.data?.error?.message?.toLowerCase().includes('quota')) {
        quotaHit = true;
        lastErr = res.data?.error?.message || 'Quota exceeded';
        continue; // quota means key IS valid
      }

      const msg = res.data?.error?.message || `HTTP ${res.status}`;
      lastErr = msg;

      // If the error is clearly about the key (not model availability), stop early
      if (
        msg.toLowerCase().includes('api key not valid') ||
        msg.toLowerCase().includes('invalid') ||
        msg.toLowerCase().includes('permission') ||
        res.status === 400 ||
        res.status === 401 ||
        res.status === 403
      ) {
        return { valid: false, detail: `Key rejected: ${msg}` };
      }

    } catch (e) {
      lastErr = e.message;
    }
  }

  if (quotaHit) {
    return {
      valid: true,
      quota: true,
      detail: 'Key is VALID — but quota/rate limit exceeded. Try later.',
    };
  }

  return {
    valid: false,
    detail: `All models failed. Last error: ${lastErr || 'Unknown'}`,
  };
}

/** Validate OpenAI API Key */
async function validateOpenAI(key) {
  try {
    const res = await httpPost(
      'api.openai.com',
      '/v1/chat/completions',
      { Authorization: `Bearer ${key}` },
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 }
    );

    if (res.status === 200 && res.data.choices) {
      return { valid: true, detail: 'gpt-4o-mini responded successfully' };
    }

    const msg = res.data?.error?.message || `HTTP ${res.status}`;

    if (res.status === 429 || msg.toLowerCase().includes('quota')) {
      return {
        valid: true,
        quota: true,
        detail: `Key is VALID — but quota/balance issue: ${msg}`,
      };
    }

    if (res.status === 401) {
      return { valid: false, detail: `Invalid API key: ${msg}` };
    }

    return { valid: false, detail: msg };
  } catch (e) {
    return { valid: false, detail: `Network error: ${e.message}` };
  }
}

/** Validate Groq API Key */
async function validateGroq(key) {
  try {
    const res = await httpPost(
      'api.groq.com',
      '/openai/v1/chat/completions',
      { Authorization: `Bearer ${key}` },
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 2,
      }
    );

    if (res.status === 200 && res.data.choices) {
      return { valid: true, detail: 'Llama 3.3 70B responded successfully' };
    }

    const msg = res.data?.error?.message || `HTTP ${res.status}`;

    if (res.status === 429 || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate')) {
      return {
        valid: true,
        quota: true,
        detail: `Key is VALID — rate limited (free tier). ${msg}`,
      };
    }

    if (res.status === 401 || msg.toLowerCase().includes('invalid')) {
      return { valid: false, detail: `Invalid API key: ${msg}` };
    }

    return { valid: false, detail: msg };
  } catch (e) {
    return { valid: false, detail: `Network error: ${e.message}` };
  }
}

/** Validate Notion API Key (just check auth, don't need DB) */
async function validateNotion(key) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.notion.com',
      path: '/v1/users/me',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Notion-Version': '2022-06-28',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve({ valid: true, detail: `Authenticated as: ${body.name || body.bot?.owner?.user?.name || 'Integration Bot'}` });
          } else if (res.statusCode === 401) {
            resolve({ valid: false, detail: `Unauthorized — API key is invalid or revoked` });
          } else {
            resolve({ valid: false, detail: body.message || `HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ valid: false, detail: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('error', (e) => resolve({ valid: false, detail: `Network error: ${e.message}` }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ valid: false, detail: 'Request timed out' }); });
    req.end();
  });
}

/** Validate Telegram Bot Token */
async function validateTelegram(token) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/getMe`,
      method: 'GET',
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (body.ok && body.result) {
            resolve({ valid: true, detail: `Bot: @${body.result.username} (${body.result.first_name})` });
          } else {
            resolve({ valid: false, detail: body.description || 'Token is invalid' });
          }
        } catch {
          resolve({ valid: false, detail: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('error', (e) => resolve({ valid: false, detail: `Network error: ${e.message}` }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ valid: false, detail: 'Request timed out' }); });
    req.end();
  });
}

// ─── KEY CONFIG MAP ───────────────────────────────────────────────────────────
const KEY_VALIDATORS = {
  GEMINI_API_KEY:      { label: 'Gemini AI',      validate: validateGemini,  icon: '🔵' },
  OPENAI_API_KEY:      { label: 'OpenAI (GPT)',    validate: validateOpenAI,  icon: '🟢' },
  GROQ_API_KEY:        { label: 'Groq (Llama)',    validate: validateGroq,    icon: '🟣' },
  NOTION_API_KEY:      { label: 'Notion',          validate: validateNotion,  icon: '📓' },
  TELEGRAM_BOT_TOKEN:  { label: 'Telegram Bot',    validate: validateTelegram,icon: '✈️' },
};

// Non-API keys (no validation needed — just check they're not empty)
const PLAIN_KEYS = ['NOTION_PARENT_DB', 'ADMIN_ID'];

// ─── VALIDATE A SINGLE KEY ────────────────────────────────────────────────────
async function validateAndReport(key, value, oldValue) {
  const cfg = KEY_VALIDATORS[key];

  if (!cfg) {
    // Plain config value — just note the change
    if (!value) {
      warn(`${key} is now EMPTY`);
    } else {
      info(`${key} updated → ${value}`);
    }
    return true; // Always keep plain keys
  }

  const { label, icon } = cfg;

  if (!value) {
    fail(`${icon} ${label} key is EMPTY — not saved`);
    if (oldValue) {
      writeKeyToEnv(key, oldValue);
      dim(`↩  Reverted ${key} to previous value`);
    }
    return false;
  }

  process.stdout.write(`${C.cyan}  🔄  Testing ${icon} ${label}...${C.reset} `);

  try {
    const result = await cfg.validate(value);

    if (result.valid) {
      if (result.quota) {
        process.stdout.write('\n');
        warn(`${icon} ${label} — ${result.detail}`);
        info(`Key is valid and has been KEPT in .env (even though quota is hit)`);
      } else {
        process.stdout.write(`${C.green}${C.bold}PASS${C.reset}\n`);
        ok(`${icon} ${label} → ${result.detail}`);
      }
      return true;
    } else {
      process.stdout.write(`${C.red}${C.bold}FAIL${C.reset}\n`);
      fail(`${icon} ${label} — ${result.detail}`);

      // Revert to old value
      if (oldValue && oldValue !== value) {
        writeKeyToEnv(key, oldValue);
        warn(`Reverted ${key} back to the previous working value`);
      } else if (!oldValue) {
        // Was empty before — remove from env or leave blank
        dim(`No previous value to revert to. Key left as-is but is INVALID.`);
      }
      return false;
    }
  } catch (e) {
    process.stdout.write(`${C.red}${C.bold}ERROR${C.reset}\n`);
    fail(`${icon} ${label} — Unexpected error: ${e.message}`);
    if (oldValue && oldValue !== value) {
      writeKeyToEnv(key, oldValue);
      warn(`Reverted ${key} back to the previous working value`);
    }
    return false;
  }
}

// ─── VALIDATE ALL KEYS IN .env (one-shot mode) ────────────────────────────────
async function validateAll() {
  head('════════════════════════════════════════════════════════════');
  head('   EXAMVAULT — API KEY VALIDATOR');
  head('════════════════════════════════════════════════════════════');

  if (!fs.existsSync(ENV_PATH)) {
    fail('.env file not found at: ' + ENV_PATH);
    process.exit(1);
  }

  const env = parseEnv(ENV_PATH);
  const results = {};

  for (const [key, cfg] of Object.entries(KEY_VALIDATORS)) {
    hr();
    const value = env[key];
    head(`  ${cfg.icon}  ${cfg.label}  (${key})`);

    if (!value) {
      warn(`Key is missing or empty in .env`);
      results[key] = { valid: false, reason: 'Missing/empty' };
      continue;
    }

    dim(`Key preview: ${value.slice(0, 12)}...`);
    const result = await cfg.validate(value);
    results[key] = result;

    if (result.valid) {
      if (result.quota) {
        warn(`QUOTA/RATE LIMIT — ${result.detail}`);
      } else {
        ok(result.detail);
      }
    } else {
      fail(result.detail);
    }
  }

  // Summary
  hr();
  head('  📋  SUMMARY');
  hr();
  let passed = 0, failed = 0;
  for (const [key, res] of Object.entries(results)) {
    const cfg = KEY_VALIDATORS[key];
    if (res.valid) {
      ok(`${cfg.icon}  ${cfg.label}`);
      passed++;
    } else {
      fail(`${cfg.icon}  ${cfg.label} — ${res.detail || res.reason || 'Failed'}`);
      failed++;
    }
  }
  hr();
  console.log(
    `\n  ${C.bold}Result: ${C.green}${passed} passed${C.reset}  ${C.red}${failed} failed${C.reset}\n`
  );
}

// ─── WATCH MODE ───────────────────────────────────────────────────────────────
function watchMode() {
  if (!fs.existsSync(ENV_PATH)) {
    fail('.env file not found. Please create it first.');
    process.exit(1);
  }

  let currentEnv = parseEnv(ENV_PATH);
  let debounceTimer = null;

  head('════════════════════════════════════════════════════════════');
  head('   EXAMVAULT — .ENV KEY WATCHER (Auto-Validate on Save)');
  head('════════════════════════════════════════════════════════════');
  info(`Watching: ${ENV_PATH}`);
  info('Edit and save your .env file — keys will be validated automatically.');
  info('Press Ctrl+C to stop.\n');

  fs.watch(ENV_PATH, (eventType) => {
    if (eventType !== 'change') return;

    // Debounce — file editors often trigger multiple events on one save
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const newEnv = parseEnv(ENV_PATH);
      const changed = [];

      // Find what changed
      const allKeys = new Set([...Object.keys(currentEnv), ...Object.keys(newEnv)]);
      for (const key of allKeys) {
        if (currentEnv[key] !== newEnv[key]) {
          changed.push({ key, oldValue: currentEnv[key] || '', newValue: newEnv[key] || '' });
        }
      }

      if (changed.length === 0) return;

      console.log(`\n${C.blue}${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
      console.log(`${C.cyan}${C.bold}  📝  .env changed — ${changed.length} key(s) updated${C.reset}`);
      console.log(`${C.blue}${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`);

      const snapshot = { ...currentEnv }; // snapshot before validation

      for (const { key, oldValue, newValue } of changed) {
        hr();
        const cfg = KEY_VALIDATORS[key];
        if (cfg) {
          head(`  ${cfg.icon}  Changed: ${cfg.label}  (${key})`);
          dim(`Old: ${oldValue ? oldValue.slice(0, 12) + '...' : '(empty)'}`);
          dim(`New: ${newValue ? newValue.slice(0, 12) + '...' : '(empty)'}`);
          const kept = await validateAndReport(key, newValue, oldValue);
          if (kept) {
            currentEnv[key] = newValue; // accept new value
          } else {
            currentEnv[key] = oldValue; // rolled back
          }
        } else {
          // Non-API key
          head(`  🔧  Changed: ${key}`);
          dim(`Old: ${oldValue || '(empty)'}`);
          dim(`New: ${newValue || '(empty)'}`);
          if (!newValue) {
            warn(`${key} is now empty — verify this is intentional`);
          } else {
            ok(`${key} updated to: ${newValue}`);
          }
          currentEnv[key] = newValue;
        }
      }

      hr();
      info('Done. Watching for next change...\n');
    }, 300);
  });
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--watch') || args.includes('-w')) {
  watchMode();
} else {
  validateAll().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
