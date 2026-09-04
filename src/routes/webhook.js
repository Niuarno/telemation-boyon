import express from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { sendOrderAlert } from '../services/telegram.js';

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

/**
 * Shopify Webhook Endpoint: POST /api/webhooks/shopify
 */
webhookRouter.post('/shopify', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const topic = req.headers['x-shopify-topic'] || 'orders/create';
  const shopDomain = req.headers['x-shopify-shop-domain'];

  // Verify HMAC signature
  const isValid = verifyShopifyHmac(req.rawBody, hmac, config.shopify.webhookSecret);

  if (!isValid) {
    console.error('❌ Unauthorized webhook request: Invalid HMAC signature.');
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  // Shopify expects an immediate 200 OK response within 5 seconds
  res.status(200).send('Webhook received');

  console.log(`\n📩 Received Shopify Webhook: [${topic}] from ${shopDomain || 'unknown'}`);

  const orderData = req.body;

  if (!orderData || !orderData.id) {
    console.warn('⚠️ Received webhook with empty order payload.');
    return;
  }

  try {
    console.log(`🚀 Dispatching Telegram notification for Order #${orderData.order_number || orderData.name || orderData.id}...`);
    await sendOrderAlert(orderData);
    console.log(`✅ Telegram alert sent successfully for Order #${orderData.order_number || orderData.name || orderData.id}`);
  } catch (err) {
    console.error('❌ Failed to send Telegram alert for order:', err.message);
  }
});
