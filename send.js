'use strict';

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// --- Config ---------------------------------------------------------------
// Config is read from config.json (copy config.example.json). The session is
// stored in .wwebjs_auth so you only scan the QR code once.
const LOGIN_ONLY = process.argv.includes('--login');
// Dry run: connect and reach 'ready' but log instead of sending. Lets the
// start/stop flow be tested end-to-end without messaging a real contact.
const DRY_RUN = process.argv.includes('--dry-run') || process.env.WA_DRY_RUN === '1';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AUTH_PATH = path.join(__dirname, '.wwebjs_auth');

function loadConfig() {
  if (LOGIN_ONLY) return { recipients: [], message: '', delayBetweenMessagesMs: 0 };
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Missing config.json. Copy config.example.json to config.json and edit it.');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(cfg.recipients) || cfg.recipients.length === 0) {
    console.error('config.json: "recipients" must be a non-empty array of phone numbers.');
    process.exit(1);
  }

  // Message override: --message "..." (CLI) or WA_MESSAGE (env) wins over
  // config.json. Lets a single script send different texts per cron job.
  const msgFlagIdx = process.argv.indexOf('--message');
  const cliMessage = msgFlagIdx !== -1 ? process.argv[msgFlagIdx + 1] : undefined;
  const override = cliMessage || process.env.WA_MESSAGE;
  if (override) cfg.message = override;

  if (!cfg.message || typeof cfg.message !== 'string') {
    console.error('No message: set "message" in config.json, or pass --message "..." / WA_MESSAGE.');
    process.exit(1);
  }
  cfg.delayBetweenMessagesMs = Number(cfg.delayBetweenMessagesMs) || 4000;
  return cfg;
}

const stamp = () => `[${new Date().toISOString()}]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize a number into WhatsApp's chat id: digits only + "@c.us".
function toChatId(raw) {
  const digits = String(raw).replace(/[^\d]/g, '');
  return `${digits}@c.us`;
}

// sendMessage() resolves when the message is QUEUED locally, not when WhatsApp's
// servers accept it. If we exit before that, the message is silently dropped.
// Wait until the message ack reaches at least SERVER (1) before continuing.
// Ack levels: -1 ERROR, 0 PENDING, 1 SERVER, 2 DEVICE, 3 READ.
// Resolves with the highest ack level observed (>=1 means WhatsApp's servers
// accepted it). The message_ack event delivers a fresh object — the original
// msg.ack does not auto-update — so we track the level from the event.
function waitForServerAck(client, msg, timeoutMs) {
  const targetId = msg.id && msg.id._serialized;
  return new Promise((resolve) => {
    let lastAck = typeof msg.ack === 'number' ? msg.ack : 0;
    let done = false;
    const finish = (ack) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poller);
      client.removeListener('message_ack', onAck);
      resolve(ack);
    };
    if (lastAck >= 1) return finish(lastAck);
    const onAck = (m) => {
      if (m && m.id && m.id._serialized === targetId) {
        lastAck = m.ack;
        if (m.ack >= 1) finish(m.ack);
      }
    };
    client.on('message_ack', onAck);
    // Fallback poll in case the event is missed.
    const poller = setInterval(() => {
      if (typeof msg.ack === 'number' && msg.ack >= 1) finish(msg.ack);
    }, 1000);
    const timer = setTimeout(() => finish(lastAck), timeoutMs);
  });
}

// --- Main -----------------------------------------------------------------
const cfg = loadConfig();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log(`${stamp()} Scan this QR with WhatsApp > Settings > Linked Devices:`);
  qrcode.generate(qr, { small: true });
});

// Diagnostic listeners — show exactly where startup hangs.
client.on('loading_screen', (percent, message) => {
  console.log(`${stamp()} loading: ${percent}% ${message || ''}`);
});
client.on('authenticated', () => console.log(`${stamp()} authenticated`));
client.on('change_state', (state) => console.log(`${stamp()} state: ${state}`));
client.on('disconnected', (reason) => console.log(`${stamp()} disconnected: ${reason}`));

client.on('auth_failure', (msg) => {
  console.error(`${stamp()} Auth failure: ${msg}`);
  process.exitCode = 1;
});

client.on('ready', async () => {
  console.log(`${stamp()} WhatsApp client ready.`);

  if (LOGIN_ONLY) {
    console.log(`${stamp()} Login complete. Session saved to ${AUTH_PATH}. You can now schedule send.js.`);
    await client.destroy();
    process.exit(0);
  }

  // 'ready' can fire before the WhatsApp socket is fully CONNECTED; sending too
  // early is what gets messages stuck at PENDING. Wait briefly for CONNECTED.
  for (let i = 0; i < 15; i++) {
    let state;
    try { state = await client.getState(); } catch (_) { state = null; }
    if (state === 'CONNECTED') break;
    await sleep(1000);
  }

  let sent = 0;
  let failed = 0;

  for (const num of cfg.recipients) {
    const chatId = toChatId(num);
    try {
      // Verify the id is actually a registered WhatsApp number before sending.
      const info = await client.getNumberId(num);
      if (!info) {
        console.error(`${stamp()} Not on WhatsApp / invalid: ${num}`);
        failed++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`${stamp()} DRY RUN: would send to ${num}: "${cfg.message}"`);
        sent++;
        continue;
      }
      const msg = await client.sendMessage(info._serialized || chatId, cfg.message);
      const ack = await waitForServerAck(client, msg, 60000);
      if (ack >= 1) {
        console.log(`${stamp()} Sent to ${num} (delivered to server, ack=${ack})`);
        sent++;
      } else {
        console.error(`${stamp()} Queued but NOT confirmed delivered to ${num} (ack=${ack}) — treating as failure`);
        failed++;
      }
    } catch (err) {
      console.error(`${stamp()} Failed to send to ${num}: ${err.message}`);
      failed++;
    }
    if (cfg.delayBetweenMessagesMs > 0) await sleep(cfg.delayBetweenMessagesMs);
  }

  console.log(`${stamp()} Done. sent=${sent} failed=${failed}`);
  await client.destroy();
  process.exit(failed > 0 ? 1 : 0);
});

// Safety net: don't hang forever if WhatsApp Web never becomes ready.
const HARD_TIMEOUT_MS = Number(process.env.WA_TIMEOUT_MS) || 5 * 60 * 1000;
setTimeout(() => {
  console.error(`${stamp()} Timed out after ${HARD_TIMEOUT_MS / 1000}s. Exiting.`);
  process.exit(1);
}, HARD_TIMEOUT_MS).unref();

client.initialize();
