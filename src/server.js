import express from 'express';
import { config, validateConfig } from './config.js';
import { initTelegramBot, bot } from './services/telegram.js';
import { webhookRouter } from './routes/webhook.js';

// Validate and diagnose configurations on startup
validateConfig();

const app = express();

// Parse JSON while preserving raw body buffer for Shopify HMAC verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Basic health check and root endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Shopify to Telegram Notification Bot',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Mount webhook endpoints
app.use('/api/webhooks', webhookRouter);
// Also support root webhook path directly for convenience (/webhook/shopify)
app.use('/webhook', webhookRouter);

// Start Telegram Bot
const telegramBot = initTelegramBot();

if (telegramBot) {
  console.log('🤖 Starting Telegram Bot polling...');
  telegramBot
    .start({
      onStart: (botInfo) => {
        console.log(`✅ Telegram bot connected as @${botInfo.username}`);
      },
    })
    .catch((err) => {
      console.error('❌ Failed to start Telegram bot polling:');
      if (err.error_code === 401) {
        console.error('   Error 401: Unauthorized. Please check that TELEGRAM_BOT_TOKEN in .env is correct and has not been revoked by @BotFather.');
      } else {
        console.error(`   ${err.message}`);
      }
    });
}

// Start HTTP Server
const server = app.listen(config.port, () => {
  console.log(`🌐 Webhook server listening on port ${config.port}`);
  console.log(`📡 Shopify Webhook URL endpoint: http://localhost:${config.port}/api/webhooks/shopify`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('\n🛑 Gracefully shutting down...');
  if (telegramBot) {
    telegramBot.stop();
  }
  server.close(() => {
    console.log('💤 Server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
