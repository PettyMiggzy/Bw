'use strict';
// Temporary diagnostic — reports which integrations are configured in THIS deployment.
// Returns booleans only (never the secret values). Safe to delete after debugging.
module.exports = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({
    resend_key_present: !!process.env.RESEND_API_KEY,
    order_from: process.env.ORDER_FROM_EMAIL || 'Burn Chronic <team@burnchronic.xyz>',
    admin_email: process.env.ADMIN_EMAIL || 'team@burnchronic.xyz',
    supabase_present: !!process.env.SUPABASE_URL,
    telegram_present: !!process.env.TG_BOT_TOKEN,
  }));
};
