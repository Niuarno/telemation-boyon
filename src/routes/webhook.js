import express from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { sendOrderAlert } from '../services/telegram.js';
import { sendWhatsAppOrderAlert } from '../services/whatsapp.js';
import { saveOrderToSupabase } from '../services/supabase.js';

export const webhookRouter = express.Router();

/**
 * Validates Shopify's HMAC SHA256 signature against the raw request body buffer
 */
export function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!secret) {
    console.warn('⚠️  [Security Warning] SHOPIFY_WEBHOOK_SECRET is not set. Skipping HMAC validation.');
    return true;
  }

  if (!hmacHeader || !rawBody) {
    return false;
  }

  try {
    const hash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    const hashBuffer = Buffer.from(hash, 'utf8');
    const hmacBuffer = Buffer.from(hmacHeader, 'utf8');

    if (hashBuffer.length !== hmacBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(hashBuffer, hmacBuffer);
  } catch (err) {
    console.error('Error during HMAC comparison:', err);
    return false;
  }
}

// In-memory deduplication cache to prevent duplicate alerts from retries or dual subscriptions (15-min TTL)
const processedOrderAlerts = new Map();

function isDuplicateOrder(orderId) {
  const now = Date.now();
  // Clean up entries older than 15 minutes
  for (const [id, time] of processedOrderAlerts.entries()) {
    if (now - time > 15 * 60 * 1000) {
      processedOrderAlerts.delete(id);
    }
  }

  if (processedOrderAlerts.has(orderId)) {
    return true;
  }

  processedOrderAlerts.set(orderId, now);
  return false;
}

/**
 * Shopify Webhook Endpoint: POST /api/webhooks/shopify
 */
webhookRouter.post('/shopify', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const topic = req.headers['x-shopify-topic'] || 'orders/create';
  const shopDomain = req.headers['x-shopify-shop-domain'] || 'unknown';

  console.log(`\n📩 Incoming Shopify Webhook: [${topic}] from ${shopDomain}`);

  // Check against either SHOPIFY_WEBHOOK_SECRET or SHOPIFY_CLIENT_SECRET
  const isValid = 
    verifyShopifyHmac(req.rawBody, hmac, config.shopify.webhookSecret) ||
    (config.shopify.clientSecret && verifyShopifyHmac(req.rawBody, hmac, config.shopify.clientSecret));

  if (!isValid) {
    console.error('❌ Unauthorized webhook: HMAC signature mismatch.');
    console.error('   Ensure SHOPIFY_WEBHOOK_SECRET in .env matches your Shopify Webhook signing secret.');
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  // Shopify expects an immediate 200 OK response within 5 seconds
  res.status(200).send('Webhook received');

  // Only dispatch order alerts for order creation events
  if (topic && topic !== 'orders/create' && !topic.endsWith('/create')) {
    console.log(`ℹ️  [Webhook] Skipping alerts for non-create topic [${topic}].`);
    return;
  }

  const orderData = req.body;

  if (!orderData || !orderData.id) {
    console.warn('⚠️ Received webhook with empty order payload.');
    return;
  }

  const orderIdentifier = `#${orderData.order_number || orderData.name || orderData.id}`;
  const dedupKey = String(orderData.id || orderData.name || orderData.order_number);

  // Guard against duplicate webhook deliveries (prevents duplicate WhatsApp and Telegram messages)
  if (isDuplicateOrder(dedupKey)) {
    console.log(`ℹ️  [Webhook] Duplicate webhook received for Order ${orderIdentifier}. Skipping duplicate alert.`);
    return;
  }

  console.log(`\n🚀 Processing new Order: ${orderIdentifier} from ${shopDomain}`);

  // Dispatch to Telegram and WhatsApp in parallel
  const dispatches = [];

  // Telegram dispatch
  dispatches.push(
    sendOrderAlert(orderData)
      .then(() => console.log(`✅ [Telegram] Alert sent successfully for Order ${orderIdentifier}`))
      .catch((err) => console.error(`❌ [Telegram] Failed to send alert: ${err.message}`))
  );

  // WhatsApp dispatch (if enabled)
  if (config.whatsapp.enabled) {
    dispatches.push(
      sendWhatsAppOrderAlert(orderData)
        .then(() => console.log(`✅ [WhatsApp] Alert sent successfully for Order ${orderIdentifier}`))
        .catch((err) => console.error(`❌ [WhatsApp] Failed to send alert: ${err.message}`))
    );
  }

  // Direct Supabase Ingest dispatch
  dispatches.push(
    saveOrderToSupabase(orderData)
      .then((res) => {
        if (res?.success) {
          console.log(`✅ [Supabase Ingest] Order ${orderIdentifier} stored in database`);
        }
      })
      .catch((err) => console.error(`❌ [Supabase Ingest] Error: ${err.message}`))
  );

  // Dashboard Ingest dispatch (if configured)
  if (config.dashboard?.ingestUrl) {
    dispatches.push(
      fetch(config.dashboard.ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': config.dashboard.internalSecret || '',
        },
        body: JSON.stringify(orderData),
      })
        .then(async (res) => {
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error(`❌ [Dashboard Ingest] HTTP ${res.status}: ${errText}`);
          } else {
            console.log(`✅ [Dashboard Ingest] Successfully forwarded Order ${orderIdentifier} to Dashboard`);
          }
        })
        .catch((err) => console.error(`❌ [Dashboard Ingest] Failed to forward order: ${err.message}`))
    );
  }

  await Promise.allSettled(dispatches);
});
