// server.js (Complete Stripe/Postgres Integration)
import express from 'express';
import Stripe from 'stripe';
import fetch from 'node-fetch';
import { Pool } from 'pg';
import 'dotenv/config';

const app = express();

// --- Configuration ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const RENDER_NOTIFY_TOKEN = process.env.RENDER_NOTIFY_TOKEN || 'changeme';
const PORT = process.env.PORT || 10000;

// Initialize Stripe and PostgreSQL Pool
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const pool = new Pool({ connectionString: DATABASE_URL });

// Test DB Connection on startup
pool.connect()
    .then(() => console.log('✅ PostgreSQL connected for Atlas Notify!'))
    .catch(err => console.error('❌ Database connection error:', err.stack));

// Middleware for all JSON endpoints (except webhooks)
app.use(express.json());

// Simple health check
app.get('/healthz', (req, res) => res.json({ ok: true }));


// --- 1. STRIPE WEBHOOK RECEIVER ---
// Must use raw body parser specifically for webhooks
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
        try {
            await handleCheckoutSessionCompleted(session);
            return res.status(200).send('ok');
        } catch (err) {
            console.error('Failed to process session:', err);
            return res.status(500).send('internal error');
        }
    }
    res.status(200).send('ignored');
});

// --- Webhook Logic (Database Write) ---
async function handleCheckoutSessionCompleted(session) {
    const email = session.customer_details?.email || session.metadata?.email;
    const plan = session.metadata?.plan || 'drop-scout';
    const sessionId = session.id;

    if (!email) {
        console.warn('Skipping session, no email found:', sessionId);
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Upsert User (Create or Update the Atlas ID record)
        const upsertUser = `
          INSERT INTO users (email, stripe_customer_id)
          VALUES ($1,$2)
          ON CONFLICT (email) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id
          RETURNING id;
        `;
        const userRes = await client.query(upsertUser, [email, session.customer]);
        const userId = userRes.rows[0].id;

        // 2. Insert Membership
        const insertMembership = `
          INSERT INTO memberships (user_id, stripe_session_id, plan, started_at)
          VALUES ($1,$2,$3,now())
          RETURNING id;
        `;
        await client.query(insertMembership, [userId, sessionId, plan]);

        await client.query('COMMIT');

        // 3. Announce to Discord
        const message = `💸 NEW MEMBER: ${email} purchased the ${plan} plan. Session: ${sessionId}`;
        await sendDiscordNotification(message);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// --- 2. CREATE CHECKOUT SESSION ---
app.post('/create-checkout-session', async (req, res) => {
    const { priceId, successUrl, cancelUrl, email } = req.body;
    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            customer_email: email,
            success_url: successUrl || 'https://yourdomain.com/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: cancelUrl || 'https://yourdomain.com/cancel',
            metadata: { plan: 'drop-scout' }
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- 3. PROTECTED NOTIFY ENDPOINT ---
app.post('/notify', async (req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${RENDER_NOTIFY_TOKEN}`) {
        return res.status(401).send('unauthorized');
    }
    const content = req.body.content || '';
    await sendDiscordNotification(content);
    res.json({ ok: true });
});

// --- Discord Helper ---
async function sendDiscordNotification(content) {
    if (!DISCORD_WEBHOOK) return;
    await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
    });
}

app.listen(PORT, () => console.log(`Atlas Notify running on ${PORT}`));
