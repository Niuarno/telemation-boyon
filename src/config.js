import dotenv from 'dotenv';

dotenv.config();

function cleanEnv(val) {
  if (!val) return '';
  return val.trim().replace(/^['"]|['"]$/g, '');
}

export const config = {
  port: parseInt(cleanEnv(process.env.PORT) || '3000', 10),
  
  telegram: {
    botToken: cleanEnv(process.env.TELEGRAM_BOT_TOKEN),
    chatId: cleanEnv(process.env.TELEGRAM_CHAT_ID),
    authorizedChatIds: cleanEnv(process.env.AUTHORIZED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID)
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
  },

  shopify: {
    shopDomain: cleanEnv(process.env.SHOPIFY_SHOP_DOMAIN).replace(/^https?:\/\//, '').replace(/\/$/, ''),
    adminAccessToken: cleanEnv(process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN),
    clientId: cleanEnv(process.env.SHOPIFY_CLIENT_ID),
    clientSecret: cleanEnv(process.env.SHOPIFY_CLIENT_SECRET),
    webhookSecret: cleanEnv(process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET),
    apiVersion: cleanEnv(process.env.SHOPIFY_API_VERSION) || '2024-01',
  },

  whatsapp: {
    enabled: cleanEnv(process.env.ENABLE_WHATSAPP).toLowerCase() === 'true',
    groupId: cleanEnv(process.env.WHATSAPP_GROUP_ID),
    phoneNumber: cleanEnv(process.env.WHATSAPP_PHONE_NUMBER || '8801974962406'),
  },

  dashboard: {
    ingestUrl: cleanEnv(process.env.DASHBOARD_INGEST_URL),
    internalSecret: cleanEnv(process.env.DASHBOARD_INTERNAL_SECRET),
  },

  supabase: {
    url: cleanEnv(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://izqyqvmakdlwflryzspn.supabase.co'),
    serviceRoleKey: cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
  },
};

/**
 * Validates essential configuration variables and logs friendly diagnostic warnings.
 */
export function validateConfig() {
  const missing = [];

  const hasAuth = Boolean(config.shopify.adminAccessToken || (config.shopify.clientId && config.shopify.clientSecret));

  if (!config.telegram.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegram.chatId) missing.push('TELEGRAM_CHAT_ID');
  if (!config.shopify.shopDomain) missing.push('SHOPIFY_SHOP_DOMAIN');
  if (!hasAuth) missing.push('SHOPIFY_ADMIN_API_ACCESS_TOKEN (or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)');

  if (missing.length > 0) {
    console.warn('\n⚠️  [Configuration Notice] Missing the following environment variables in .env:');
    missing.forEach(v => console.warn(`   - ${v}`));
    console.warn('   The server will still run, but some features (Shopify API or Telegram) may be restricted until provided.\n');
  }

  if (!config.shopify.webhookSecret) {
    console.warn('⚠️  [Security Warning] SHOPIFY_WEBHOOK_SECRET is not set. Webhook HMAC verification will be bypassed or fail.\n');
  }
}
