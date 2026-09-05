import { Bot } from 'grammy';
import { config } from '../config.js';
import { getRecentOrders, getOrderByIdOrName } from './shopify.js';

export let bot = null;

/**
 * Escapes HTML characters for safe Telegram HTML formatting
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats a currency amount nicely
 */
function formatCurrency(amount, currency = 'BDT') {
  const num = parseFloat(amount || 0);
  return `${num.toFixed(2)} ${currency}`;
}

function getStatusBadge(status) {
  switch (status?.toLowerCase()) {
    case 'paid':
    case 'authorized':
      return '🟢 paid';
    case 'pending':
      return '🟡 pending';
    case 'refunded':
    case 'voided':
      return '🔴 ' + status;
    case 'fulfilled':
      return '📦 Fulfilled';
    case 'unfulfilled':
      return '⏳ Unfulfilled';
    case 'partial':
      return '🌗 Partially Fulfilled';
    default:
      return status || 'N/A';
  }
}

/**
 * Formats a full order alert into the clean, compact Telegram HTML message
 */
export function formatOrderNotification(order) {
  const orderNumber = escapeHtml(order.name || `#${order.order_number || order.id}`);
  const currency = order.currency || order.presentment_currency || 'BDT';
  const totalPrice = formatCurrency(order.total_price || order.current_total_price, currency);

  // Customer Details (clean up single-name '-' placeholder)
  const cleanStr = (s) => (s && typeof s === 'string' && s.trim() !== '-' ? s.trim() : '');
  const noteName = order.note_attributes?.find(a => /name/i.test(a.name))?.value;
  
  const firstName = cleanStr(order.customer?.first_name || order.shipping_address?.first_name || order.billing_address?.first_name);
  const lastName = cleanStr(order.customer?.last_name || order.shipping_address?.last_name || order.billing_address?.last_name);
  const combinedName = [firstName, lastName].filter(Boolean).join(' ');
  
  const rawCustomerName = combinedName ||
    cleanStr(order.shipping_address?.name) ||
    cleanStr(order.billing_address?.name) ||
    cleanStr(noteName) ||
    'Guest';
  const customerName = escapeHtml(rawCustomerName.replace(/\s*-\s*$/, ''));

  const email = escapeHtml(order.email || order.contact_email || order.customer?.email || '');

  // Phone
  const notePhone = order.note_attributes?.find(a => /phone/i.test(a.name))?.value;
  const phone = escapeHtml(
    order.phone || 
    order.shipping_address?.phone || 
    order.billing_address?.phone || 
    order.customer?.phone || 
    notePhone || 
    ''
  );

  // Full Address (includes address1, address2, city, country)
  const addr = order.shipping_address || order.billing_address || order.customer?.default_address || {};
  const noteAddress = order.note_attributes?.find(a => /address/i.test(a.name))?.value;

  const addressParts = [];
  const line1 = cleanStr(addr.address1) || cleanStr(noteAddress);
  if (line1) addressParts.push(line1);
  if (cleanStr(addr.address2)) addressParts.push(cleanStr(addr.address2));

  const city = cleanStr(addr.city);
  const province = cleanStr(addr.province);
  const country = cleanStr(addr.country);
  const cityRegion = [city, province, country].filter(Boolean).join(', ');
  if (cityRegion) addressParts.push(cityRegion);

  const fullAddress = addressParts.length > 0 
    ? escapeHtml(addressParts.join(', ')) 
    : 'No address provided';

  // Line items
  const items = (order.line_items || []).map((item) => {
    const qty = item.quantity;
    const title = escapeHtml(item.title || item.name || 'Item');
    const variant = item.variant_title ? ` (${escapeHtml(item.variant_title)})` : '';
    const itemPrice = formatCurrency(item.price, currency);
    return `  • <b>${qty}x</b> ${title}${variant} — <code>${itemPrice}</code>`;
  });

  const itemsList = items.length > 0 
    ? items.slice(0, 10).join('\n') + (items.length > 10 ? `\n  <i>...and ${items.length - 10} more item(s)</i>` : '')
    : '  <i>No items listed</i>';

  // Statuses
  const gateway = order.payment_gateway_names?.length > 0 
    ? order.payment_gateway_names.join(', ') 
    : (order.gateway || '');
  const finBadge = getStatusBadge(order.financial_status);
  const paymentDisplay = gateway ? `${finBadge} (${escapeHtml(gateway)})` : finBadge;
  const fulfillmentStatus = getStatusBadge(order.fulfillment_status || 'unfulfilled');

  // Shopify Admin Direct Link
  const adminUrl = config.shopify.shopDomain 
    ? `https://${config.shopify.shopDomain}/admin/orders/${order.id}` 
    : null;

  let msg = `🛍️ <b>NEW SHOPIFY ORDER</b> <code>${orderNumber}</code>\n\n`;
  msg += `👤 <b>Customer:</b> ${customerName}\n`;
  if (email) msg += `✉️ <b>Email:</b> ${email}\n`;
  if (phone) msg += `📞 <b>Phone:</b> ${phone}\n`;
  msg += `📍 <b>Ship To:</b> ${fullAddress}\n`;

  msg += `\n📦 <b>Items (${order.line_items?.length || 0}):</b>\n${itemsList}\n\n`;
  msg += `💰 <b>Total:</b> <b>${totalPrice}</b>\n`;
  msg += `💳 <b>Payment:</b> ${paymentDisplay}\n`;
  msg += `🚚 <b>Fulfillment:</b> ${fulfillmentStatus}\n`;

  if (order.note) {
    msg += `📝 <b>Order Note:</b> <i>${escapeHtml(order.note)}</i>\n`;
  }

  if (adminUrl) {
    msg += `\n🔗 <a href="${adminUrl}">Open in Shopify Admin</a>`;
  }

  return msg;
}

/**
 * Formats a list of recent orders for the /orders command
 */
export function formatRecentOrdersList(orders) {
  if (!orders || orders.length === 0) {
    return '📭 No recent orders found in your Shopify store.';
  }

  let msg = `📋 <b>Recent Orders (${orders.length}):</b>\n\n`;

  orders.forEach((order) => {
    const orderName = escapeHtml(order.name || `#${order.order_number || order.id}`);
    const currency = order.currency || 'USD';
    const total = formatCurrency(order.total_price, currency);
    const customer = escapeHtml(
      [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Guest'
    );
    const finStatus = order.financial_status || 'unknown';
    const fulStatus = order.fulfillment_status || 'unfulfilled';
    const date = new Date(order.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    msg += `🛒 <b>${orderName}</b> — <b>${total}</b>\n`;
    msg += `   👤 ${customer} | 💳 ${finStatus} | 🚚 ${fulStatus}\n`;
    msg += `   📅 <i>${date}</i>\n\n`;
  });

  msg += `💡 <i>Tip: Send <code>/order #ORDER_NUMBER</code> for full breakdown.</i>`;
  return msg;
}

/**
 * Initializes and registers bot commands
 */
export function initTelegramBot() {
  if (!config.telegram.botToken) {
    console.warn('⚠️  Telegram bot token is not configured. Telegram bot service disabled.');
    return null;
  }

  bot = new Bot(config.telegram.botToken);

  // Security Middleware: Validate chat authorization for sensitive commands
  const requireAuth = async (ctx, next) => {
    const chatId = String(ctx.chat?.id || '');
    const fromId = String(ctx.from?.id || '');
    const allowed = config.telegram.authorizedChatIds;

    // If no authorized IDs are specified, permit all (or fallback to configured TELEGRAM_CHAT_ID)
    if (allowed.length === 0 || allowed.includes(chatId) || allowed.includes(fromId)) {
      return next();
    }

    await ctx.reply(
      `⛔ <b>Access Restricted</b>\n\nThis chat (ID: <code>${chatId}</code>) is not authorized to query store orders.\n\nAdd this Chat ID to <code>AUTHORIZED_CHAT_IDS</code> or <code>TELEGRAM_CHAT_ID</code> in your <code>.env</code> file.`,
      { parse_mode: 'HTML' }
    );
  };

  // /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `👋 <b>Hello! I am your Shopify Order Notification Bot.</b>\n\n` +
      `I listen for real-time Shopify order events and notify this group instantly.\n\n` +
      `<b>Available Commands:</b>\n` +
      `• /orders [limit] - View recent orders (e.g. <code>/orders 5</code>)\n` +
      `• /order &lt;number&gt; - View details of a specific order (e.g. <code>/order #1001</code>)\n` +
      `• /status - View bot & Shopify connection status\n` +
      `• /help - Display usage instructions`,
      { parse_mode: 'HTML' }
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📖 <b>Shopify Bot Command Guide:</b>\n\n` +
      `• <code>/orders</code> — Shows the last 5 orders.\n` +
      `• <code>/orders 10</code> — Shows the last 10 orders (max 20).\n` +
      `• <code>/order 1001</code> — Retrieves order #1001.\n` +
      `• <code>/order #1001</code> — Retrieves order #1001.\n` +
      `• <code>/status</code> — Shows current Chat ID, store domain, and bot state.\n\n` +
      `🔔 <i>New orders will be posted automatically to the configured notification chat!</i>`,
      { parse_mode: 'HTML' }
    );
  });

  // /status command (diagnostic & helper to find chat ID)
  bot.command('status', async (ctx) => {
    const isTargetChat = String(ctx.chat.id) === String(config.telegram.chatId);
    const shopConfigured = Boolean(
      config.shopify.shopDomain &&
      (config.shopify.adminAccessToken || (config.shopify.clientId && config.shopify.clientSecret))
    );

    await ctx.reply(
      `⚙️ <b>Bot & System Status:</b>\n\n` +
      `• <b>Current Chat ID:</b> <code>${ctx.chat.id}</code>\n` +
      `• <b>Chat Type:</b> <code>${ctx.chat.type}</code>\n` +
      `• <b>Is Notification Target:</b> ${isTargetChat ? '✅ Yes' : '⚠️ No (configured target: <code>' + (config.telegram.chatId || 'not set') + '</code>)'}\n` +
      `• <b>Shopify Store:</b> <code>${config.shopify.shopDomain || 'Not configured'}</code>\n` +
      `• <b>Shopify API Status:</b> ${shopConfigured ? '🟢 Credentials loaded' : '🔴 Missing credentials'}\n` +
      `• <b>Webhook HMAC Verification:</b> ${config.shopify.webhookSecret ? '🟢 Enabled' : '🟡 Secret not set'}`,
      { parse_mode: 'HTML' }
    );
  });

  // /orders command
  bot.command('orders', requireAuth, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const limit = args[0] ? parseInt(args[0], 10) : 5;

    await ctx.replyWithChatAction('typing');

    try {
      const orders = await getRecentOrders(limit);
      const message = formatRecentOrdersList(orders);
      await ctx.reply(message, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (err) {
      console.error('Error in /orders command:', err);
      await ctx.reply(`❌ <b>Failed to fetch orders:</b>\n<code>${escapeHtml(err.message)}</code>`, {
        parse_mode: 'HTML',
      });
    }
  });

  // /order command
  bot.command('order', requireAuth, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const query = args[0];

    if (!query) {
      return ctx.reply('⚠️ Please provide an order number or ID.\nExample: <code>/order #1001</code>', {
        parse_mode: 'HTML',
      });
    }

    await ctx.replyWithChatAction('typing');

    try {
      const order = await getOrderByIdOrName(query);
      if (!order) {
        return ctx.reply(`🔍 Order <b>${escapeHtml(query)}</b> was not found in Shopify.`, {
          parse_mode: 'HTML',
        });
      }

      const message = formatOrderNotification(order);
      await ctx.reply(message, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (err) {
      console.error('Error in /order command:', err);
      await ctx.reply(`❌ <b>Failed to retrieve order:</b>\n<code>${escapeHtml(err.message)}</code>`, {
        parse_mode: 'HTML',
      });
    }
  });

  bot.catch((err) => {
    console.error('Telegram Bot Error:', err);
  });

  return bot;
}

/**
 * Dispatches an order alert to the designated Telegram group
 */
export async function sendOrderAlert(order) {
  if (!bot) {
    throw new Error('Telegram bot is not initialized');
  }

  if (!config.telegram.chatId) {
    throw new Error('TELEGRAM_CHAT_ID is not configured in .env');
  }

  const message = formatOrderNotification(order);

  return await bot.api.sendMessage(config.telegram.chatId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}
