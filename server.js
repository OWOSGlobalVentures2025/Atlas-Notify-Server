// server.js
const express = require('express');
const Stripe = require('stripe');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const NOTIFY_TOKEN = process.env.RENDER_NOTIFY_TOKEN || 'changeme';

app.use(express.json());

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { priceId, email, successUrl, cancelUrl } = req.body;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: successUrl || 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl || 'https://example.com/cancel',
      metadata: { plan: 'drop-scout' }
    });
    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('create-checkout error', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('Checkout session completed:', session.id, 'email:', session.customer_details?.email);
    const email = session.customer_details?.email || session.metadata?.email || 'unknown';
    const plan = session.metadata?.plan || 'drop-scout';
    const msg = `💸 New ${plan} member: ${email} — session ${session.id}`;
    await sendDiscordNotification(msg);
  }

  res.json({ received: true });
});

app.post('/notify', express.json(), async (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${NOTIFY_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const content = req.body.content || '';
  try {
    await sendDiscordNotification(content);
    return res.json({ ok: true });
  } catch (err) {
    console.error('notify send failed', err);
    return res.status(500).json({ error: 'failed' });
  }
});

async function sendDiscordNotification(content) {
  if (!DISCORD_WEBHOOK) {
    console.log('[notify skip] no DISCORD_WEBHOOK_URL set');
    return;
  }
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Atlas Notify server listening on ${PORT}`));
