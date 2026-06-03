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
      await client.sendMessage(info._serialized || chatId, cfg.message);
      console.log(`${stamp()} Sent to ${num}`);
      sent++;
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
