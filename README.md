# 🛍️ Telemation: Shopify to Telegram Order Bot

A fast, lightweight, and secure Node.js service that connects your Shopify store to a Telegram group. It instantly notifies your team when a new order arrives and allows querying recent orders directly from chat.

---

## 🌟 Key Features

- **⚡ Instant Dual Alerts**: Dispatches rich, itemized notifications whenever an `orders/create` webhook is received from Shopify to both **Telegram** and **WhatsApp**.
- **📱 Personal WhatsApp Integration**: Connect your own personal WhatsApp account directly via Multi-Device QR code (no Meta WhatsApp Business API fees!).
- **🔒 Tamper-Proof Webhook Security**: Verifies Shopify's `X-Shopify-Hmac-Sha256` signature using your app secret.
- **💬 In-Chat Order Lookups**:
  - `/orders [limit]` — Retrieves latest orders (default: 5).
  - `/order <order_number_or_id>` — Detailed breakdown of a specific order (e.g. `/order #1024`).
  - `/status` — Displays bot health, shop domain, and the current Chat ID.
  - `/help` — Command guide.
- **🛡️ Access Protection**: Restricts lookup commands to authorized chat/group IDs to safeguard customer information.

---

## 📋 Quick Setup Guide

### Step 1: Telegram Bot Setup

1. Open Telegram and search for [`@BotFather`](https://t.me/BotFather).
2. Send `/newbot`, then follow the prompts to choose a bot name and username (e.g., `MyStoreOrderBot`).
3. `@BotFather` will provide your **HTTP API Token**. Copy this token — you will use it as `TELEGRAM_BOT_TOKEN`.
4. Create or open your Telegram group and **add your new bot as a member**. (Make sure to give it permission to send messages; making it an Admin is recommended).
5. **Find your Group Chat ID**:
   - Add the bot to your group, start the server (`npm start`), and type `/status` in the group. The bot will reply with your exact `Chat ID` (e.g., `-1001234567890`)!
   - Alternatively, add [`@RawDataBot`](https://t.me/RawDataBot) to the group to inspect the chat ID.

---

### Step 2: Shopify API Setup

1. In your Shopify Admin, go to **Settings** > **Apps and sales channels** > **Develop apps**.
2. Click **Create an app** (Name it e.g. `Order Notifier`).
3. Click **Configure Admin API scopes**:
   - Enable **`read_orders`** (and optionally `read_customers`).
4. Click **Save**, then click **Install app** at the top right.
5. Reveal and copy the **Admin API access token** (starts with `shpat_...`) or use your Dev Dashboard Client ID + Secret.
6. Note your store domain (e.g., `my-shop-name.myshopify.com`).

---

### Step 3: WhatsApp Setup (Personal Account)

1. Set `ENABLE_WHATSAPP=true` in your `.env` file.
2. Run `npm start`. A QR code will display in your terminal.
3. Open WhatsApp on your phone:
   - On Android: Tap the 3 dots (top-right) > **Linked devices** > **Link a device**.
   - On iPhone: Go to **Settings** > **Linked Devices** > **Link a device**.
4. Scan the terminal QR code.
5. Once connected, the console will **automatically list all your WhatsApp groups with their exact IDs**!
6. Copy the target group ID (e.g. `120363028123456789@g.us`) and paste it into `WHATSAPP_GROUP_ID` in your `.env` file.

---

### Step 4: Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in your details.

---

### Step 5: Run the Bot

1. Install dependencies (if not already done):
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
   Or run in development watch mode:
   ```bash
   npm run dev
   ```

---

### Step 6: Connect Shopify Webhook

Shopify sends webhooks via HTTPS. For development on localhost, you can expose your local server using a tunnel:

#### Option A: Using Cloudflare Tunnel (Free, No Signup Required)
Run this in a separate terminal:
```bash
npx untun@latest tunnel http://localhost:3000
```
or if you have `cloudflared`:
```bash
cloudflared tunnel --url http://localhost:3000
```

#### Option B: Using Ngrok
```bash
ngrok http 3000
```

#### Register the Webhook in Shopify:
1. In Shopify Admin, navigate to **Settings** > **Notifications** > scroll down to **Webhooks**.
2. Click **Create webhook**:
   - **Event**: `Order creation`
   - **Format**: `JSON`
   - **URL**: `https://<YOUR-TUNNEL-URL>/api/webhooks/shopify`
   - **Webhook API version**: `2024-01` (or latest)
3. Save the webhook.
4. At the bottom of the Webhooks section, locate **"Your webhooks will be signed with `...`"**. Copy that secret into `SHOPIFY_WEBHOOK_SECRET` in your `.env` file.
5. Click **"Send test notification"** on Shopify Admin to verify an instant notification appears in your Telegram group!

---

## 🧪 Testing Locally

You can test the formatting and HMAC verification at any time without triggering a real Shopify purchase:

```bash
npm run test:webhook
```

---

## 🚀 Telegram Commands Reference

| Command | Description | Example |
| :--- | :--- | :--- |
| `/orders` | View the last 5 orders | `/orders` |
| `/orders <n>` | View the last `n` orders (max 20) | `/orders 10` |
| `/order <id>` | View full breakdown for a specific order | `/order #1024` or `/order 1024` |
| `/status` | View bot status, connected store, & current Chat ID | `/status` |
| `/help` | Display command instructions | `/help` |

---

## 🌐 Production Deployment

You can deploy this lightweight Node.js service to any hosting provider:
- **Render / Railway / Fly.io / Heroku**: Point the repository, set the environment variables in the dashboard, and configure the public webhook URL in Shopify.
- **VPS / Docker / PM2**: Run `pm2 start src/server.js --name shopify-telegram` behind Nginx with Let's Encrypt SSL.
