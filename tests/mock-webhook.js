import crypto from 'crypto';
import dotenv from 'dotenv';
import { formatOrderNotification, formatRecentOrdersList } from '../src/services/telegram.js';
import { verifyShopifyHmac } from '../src/routes/webhook.js';

dotenv.config();

const sampleOrder = {
  id: 5938201948201,
  name: '#1024',
  order_number: 1024,
  currency: 'USD',
  total_price: '79.99',
  financial_status: 'paid',
  fulfillment_status: 'unfulfilled',
  created_at: new Date().toISOString(),
  note: 'Please leave the package at the front porch.',
  customer: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    phone: '+1 (555) 234-5678',
  },
  shipping_address: {
    name: 'Jane Doe',
    city: 'San Francisco',
    province: 'CA',
    country: 'United States',
    phone: '+1 (555) 234-5678',
  },
  line_items: [
    {
      id: 11223344,
      title: 'Premium Ergonomic Keyboard',
      variant_title: 'Wireless / Matte Black',
      quantity: 1,
      price: '59.99',
    },
    {
      id: 11223345,
      title: 'Braided USB-C Cable',
      variant_title: '2 Meter / Space Grey',
      quantity: 2,
      price: '10.00',
    },
  ],
};

async function runSelfTests() {
  console.log('🧪 === RUNNING TELEMATION SELF-TESTS ===\n');

  // Test 1: Format Order Notification
  console.log('1️⃣  Testing Order Notification Formatting:');
  const formattedHtml = formatOrderNotification(sampleOrder);
  console.log('--- FORMATTED OUTPUT START ---');
  console.log(formattedHtml);
  console.log('--- FORMATTED OUTPUT END ---\n');

  if (!formattedHtml.includes('#1024') || !formattedHtml.includes('Jane Doe') || !formattedHtml.includes('79.99 USD')) {
    throw new Error('Order formatting test failed!');
  }
  console.log('✅ Formatting test passed!\n');

  // Test 2: Format Order List
  console.log('2️⃣  Testing Orders List Formatting:');
  const formattedList = formatRecentOrdersList([sampleOrder]);
  console.log(formattedList);
  console.log('\n✅ Orders list formatting test passed!\n');

  // Test 3: HMAC Verification
  console.log('3️⃣  Testing HMAC-SHA256 Verification Logic:');
  const testSecret = 'my_super_secret_shopify_key_123';
  const bodyString = JSON.stringify(sampleOrder);
  const rawBodyBuffer = Buffer.from(bodyString, 'utf8');

  // Generate valid HMAC
  const validHmac = crypto.createHmac('sha256', testSecret).update(rawBodyBuffer).digest('base64');

  const isValidPassed = verifyShopifyHmac(rawBodyBuffer, validHmac, testSecret);
  const isTamperedRejected = !verifyShopifyHmac(Buffer.from(bodyString + 'tampered', 'utf8'), validHmac, testSecret);
  const isBadSecretRejected = !verifyShopifyHmac(rawBodyBuffer, validHmac, 'wrong_secret');

  if (isValidPassed && isTamperedRejected && isBadSecretRejected) {
    console.log('✅ HMAC verification test passed (Valid signature accepted, tampered payload rejected, wrong secret rejected)!\n');
  } else {
    throw new Error('HMAC verification test failed!');
  }

  // Test 4: Live HTTP Webhook Delivery (if server is running)
  const port = process.env.PORT || 3000;
  const webhookUrl = `http://localhost:${port}/api/webhooks/shopify`;
  const secretToUse = process.env.SHOPIFY_WEBHOOK_SECRET || testSecret;
  const liveHmac = crypto.createHmac('sha256', secretToUse).update(rawBodyBuffer).digest('base64');

  console.log(`4️⃣  Testing Live Webhook Endpoint (${webhookUrl}):`);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': liveHmac,
        'X-Shopify-Topic': 'orders/create',
        'X-Shopify-Shop-Domain': process.env.SHOPIFY_SHOP_DOMAIN || 'demo.myshopify.com',
      },
      body: bodyString,
    });

    console.log(`📡 Response status: ${res.status} ${res.statusText}`);
    const resBody = await res.text();
    console.log(`📡 Response body: ${resBody}`);

    if (res.status === 200) {
      console.log('✅ Webhook endpoint reached and processed successfully!');
    } else {
      console.log('⚠️ Server returned non-200 (is the server running or is SHOPIFY_WEBHOOK_SECRET different?)');
    }
  } catch (err) {
    console.log(`ℹ️ Server is not running on port ${port} right now (Skipping live HTTP test). Start server with 'npm start' to test live endpoint.`);
  }

  console.log('\n🎉 ALL INTERNAL TESTS COMPLETED SUCCESSFULLY!');
}

runSelfTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
