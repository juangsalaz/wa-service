const express = require('express');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'jfskljfskfhsfsdf23423424';

const app = express();
app.use(express.json({ limit: '4mb' }));

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'kirim-wa' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
    executablePath: puppeteer.executablePath(),
  },
  webVersionCache: { type: 'local' },
});

let isReady = false;

client.on('change_state', state => {
  console.log('🔄 State:', state);
});

// QR login pertama kali
client.on('qr', qr => {
  console.log('Scan QR berikut untuk login:');
  qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => console.log('✅ Authenticated'));
client.on('auth_failure', m => console.error('❌ Auth failure:', m));
client.on('loading_screen', (p, m) => console.log(`⏳ Loading ${p}% - ${m}`));

client.on('ready', () => {
  isReady = true;
  console.log('✅ WhatsApp siap!');
});

client.on('disconnected', reason => {
  isReady = false;
  console.warn('⚠️ Disconnected:', reason);
});


client.initialize().catch(e => console.error('Init error:', e));

/* ----------------- Resolver nama grup dgn cache sederhana ----------------- */
const groupCache = new Map(); // key: nameLower -> { id, ts }
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 jam

async function resolveGroupIdByName(name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();

  // Cache hit?
  const hit = groupCache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.id;

  // Fetch semua chat grup
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);

  // Prioritas pencocokan: exact -> case-insensitive -> contains
  const exact = groups.find(g => g.name === name);
  const iexact = exact ? null : groups.find(g => g.name.toLowerCase() === key);
  const contains = (exact || iexact) ? null : groups.find(g => g.name.toLowerCase().includes(key));

  const target = exact || iexact || contains || null;
  if (target) {
    groupCache.set(key, { id: target.id._serialized, ts: Date.now() });
    return target.id._serialized;
  }
  return null;
}

// Bantu tampilkan rekomendasi kalau tidak ketemu
async function listGroupSuggestions(part) {
  const key = (part || '').toLowerCase().trim();
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);
  const filtered = key ? groups.filter(g => g.name.toLowerCase().includes(key)) : groups;
  return filtered.slice(0, 20).map(g => g.name);
}

// --- Helper nomor pribadi ---
function normalizePhoneToE164Indo(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, ''); // buang spasi, tanda
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '62' + s.slice(1);
  // kalau sudah 62... biarkan
  if (!/^\d{8,15}$/.test(s)) return null; // panjang wajar
  return s; // tanpa '+'
}

async function resolveWhatsAppId(phone) {
  // return: '628xxxx@c.us' atau null kalau tidak punya WA
  const e164 = normalizePhoneToE164Indo(phone);
  if (!e164) return null;
  try {
    const numberInfo = await client.getNumberId(e164);
    return numberInfo ? numberInfo._serialized : null; // contoh: 628xxx@c.us
  } catch {
    return null;
  }
}

/* ------------------------------ Middleware API Key ------------------------------ */
function requireApiKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

/* ----------------------------------- Routes ----------------------------------- */
app.get('/health', async (_req, res) => {
  let state = 'UNKNOWN';
  try { state = await client.getState(); } catch {}
  res.json({ ok: true, ready: isReady, state });
});

app.get('/state', async (_req, res) => {
  try {
    const state = await client.getState();
    return res.json({ ok: true, state, ready: isReady });
  } catch (e) {
    return res.status(503).json({ ok: false, error: e.message, ready: isReady });
  }
});

app.post('/reinit', requireApiKey, async (req, res) => {
  try {
    const state = await client.getState().catch(() => null);

    if (state === 'CONNECTED') {
      return res.json({ ok: true, message: 'already connected' });
    }

    console.log('♻️ Soft reinitialize...');
    isReady = false;
    client.initialize(); // TANPA destroy

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});



// Body:
// {
//   "groupName": "Pengajian SGN",
//   "text": "Isi pesan",
//   "base64Files": [{"mime":"image/png","data":"iVBOR...","filename":"rekap.png","caption":"Rekap"}]
// }
app.post('/send-group', requireApiKey, async (req, res) => {
  if (!isReady) return res.status(503).json({ ok: false, error: 'whatsapp not ready' });

  const { groupName, text, base64Files = [] } = req.body || {};
  if (!groupName || !(text || base64Files.length)) {
    return res.status(400).json({ ok: false, error: 'groupName dan text/base64Files wajib diisi' });
  }

  try {
    const groupId = await resolveGroupIdByName(groupName);
    if (!groupId) {
      const suggestions = await listGroupSuggestions(groupName);
      return res.status(404).json({
        ok: false,
        error: `Grup "${groupName}" tidak ditemukan`,
        suggestions,
      });
    }

    if (text && text.trim()) {
      await client.sendMessage(groupId, text);
    }

    for (const f of base64Files) {
      const media = new MessageMedia(f.mime, f.data, f.filename || 'file');
      await client.sendMessage(groupId, media, { caption: f.caption || '' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/send-personal', requireApiKey, async (req, res) => {
  if (!isReady) return res.status(503).json({ ok: false, error: 'whatsapp not ready' });

  const { phone, phones, text, base64Files = [], validateOnly = false } = req.body || {};
  let targets = [];

  if (Array.isArray(phones) && phones.length) targets = phones;
  else if (phone) targets = [phone];

  if (!targets.length) {
    return res.status(400).json({ ok: false, error: 'phone atau phones wajib diisi' });
  }
  if (!validateOnly && !(text || (base64Files && base64Files.length))) {
    return res.status(400).json({ ok: false, error: 'text atau base64Files wajib diisi untuk pengiriman' });
  }

  const results = [];
  for (const p of targets) {
    const normalized = normalizePhoneToE164Indo(p);
    if (!normalized) {
      results.push({ to: p, ok: false, error: 'nomor tidak valid' });
      continue;
    }

    const waId = await resolveWhatsAppId(normalized);
    if (!waId) {
      results.push({ to: normalized, ok: false, error: 'nomor tidak terdaftar di WhatsApp' });
      continue;
    }

    if (validateOnly) {
      results.push({ to: normalized, waId, ok: true, validated: true });
      continue;
    }

    try {
      if (text && text.trim()) {
        await client.sendMessage(waId, text);
      }
      for (const f of base64Files) {
        const media = new MessageMedia(f.mime, f.data, f.filename || 'file');
        await client.sendMessage(waId, media, { caption: f.caption || '' });
      }
      results.push({ to: normalized, waId, ok: true });
      // throttle ringan agar aman dari rate limit
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      results.push({ to: normalized, waId, ok: false, error: e.message });
    }
  }

  const okAny = results.some(r => r.ok);
  res.status(okAny ? 200 : 400).json({ ok: okAny, results });
});


app.listen(PORT, () => console.log(`WA service listening on :${PORT}`));
