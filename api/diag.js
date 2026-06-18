'use strict';
// Temporary diagnostic — reports which integrations are live + can send ONE test email.
// Booleans only (never exposes secrets); test email only goes to admin_email. Delete after debugging.
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const out = {
    resend_key_present: !!process.env.RESEND_API_KEY,
    order_from: process.env.ORDER_FROM_EMAIL || 'Burn Chronic <team@burnchronic.xyz>',
    admin_email: process.env.ADMIN_EMAIL || 'team@burnchronic.xyz',
    supabase_present: !!process.env.SUPABASE_URL,
    telegram_present: !!process.env.TG_BOT_TOKEN,
  };
  let send = false;
  try { send = new URL(req.url, 'http://x').searchParams.get('sendtest') === '1'; } catch (_) {}
  if (send && process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: out.order_from, to: [out.admin_email], subject: '🧪 CHRONIC email test', html: '<p>If you got this, Resend sending works ✅</p>' }),
      });
      out.resend_status = r.status;
      out.resend_response = (await r.text()).slice(0, 400);
    } catch (e) { out.resend_error = (e && e.message) || String(e); }
  }
  res.statusCode = 200;
  res.end(JSON.stringify(out));
};
