'use strict';
/*
 * POST /api/merchpad — a project requests a $CHRONIC-powered merch store.
 * Body: { project, contactName?, contact, wallet?, details?, artUrl? }
 * Stores in Supabase (grow_merchpad) + pings Telegram. Origin-guarded.
 */
const G = require('./_grow.js');
const { blocked } = require('./_guard.js');

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const S = (v, n) => (v == null ? '' : String(v)).slice(0, n || 200);

async function tgAlert(row) {
  const tok = process.env.TG_BOT_TOKEN, chat = process.env.TG_MERCH_CHAT || process.env.TG_ORDER_CHAT;
  if (!tok || !chat) return;
  const text = `🏭 MERCH PAD REQUEST\n🏷️ ${row.project}\n👤 ${row.contact_name || '—'}\n✉️ ${row.contact}\n${row.wallet ? '💳 ' + row.wallet + '\n' : ''}${row.art_url ? '🎨 ' + row.art_url + '\n' : ''}${row.details ? '📝 ' + row.details : ''}`;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (_) {}
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
  if (blocked(req, res)) return;

  const b = await readJson(req);
  const project = S(b.project, 80).trim();
  const contact = S(b.contact, 160).trim();
  if (!project || !contact) { res.statusCode = 400; res.end(JSON.stringify({ error: 'project and contact are required' })); return; }

  const row = {
    project,
    contact_name: S(b.contactName, 80).trim() || null,
    contact,
    wallet: S(b.wallet, 80).trim() || null,
    details: S(b.details, 1000).trim() || null,
    art_url: S(b.artUrl, 300).trim() || null,
    status: 'new',
    created_at: new Date().toISOString(),
  };

  try { if (G.sbEnabled()) await G.sbUpsert('grow_merchpad', row); } catch (_) {}
  await tgAlert(row);

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
};
