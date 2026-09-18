import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from '../config.js';

export let waSocket = null;
let isConnecting = false;

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
 * Formats an order into a clean WhatsApp Markdown message
 */
export function formatWhatsAppOrder(order) {
  const orderNumber = order.name || `#${order.order_number || order.id}`;
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
  const customerName = rawCustomerName.replace(/\s*-\s*$/, '');

  const email = order.email || order.contact_email || order.customer?.email || '';

  // Phone
  const notePhone = order.note_attributes?.find(a => /phone/i.test(a.name))?.value;
  const phone = order.phone || 
    order.shipping_address?.phone || 
    order.billing_address?.phone || 
    order.customer?.phone || 
    notePhone || 
    '';

  // Address
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

  const fullAddress = addressParts.length > 0 ? addressParts.join(', ') : 'No address provided';

  // Line items
  const items = (order.line_items || []).map((item) => {
    const qty = item.quantity;
    const title = item.title || item.name || 'Item';
    const variant = item.variant_title ? ` (${item.variant_title})` : '';
    const itemPrice = formatCurrency(item.price, currency);
    return `  • *${qty}x* ${title}${variant} — ${itemPrice}`;
  });

  const itemsList = items.length > 0 
    ? items.slice(0, 10).join('\n') + (items.length > 10 ? `\n  _...and ${items.length - 10} more item(s)_` : '')
    : '  _No items listed_';

  // Statuses
  const gateway = order.payment_gateway_names?.length > 0 
    ? order.payment_gateway_names.join(', ') 
    : (order.gateway || '');
  const finBadge = getStatusBadge(order.financial_status);
  const paymentDisplay = gateway ? `${finBadge} (${gateway})` : finBadge;
  const fulfillmentStatus = getStatusBadge(order.fulfillment_status || 'unfulfilled');

  // Shopify Admin Link
  const adminUrl = config.shopify.shopDomain 
    ? `https://${config.shopify.shopDomain}/admin/orders/${order.id}` 
    : null;

  let msg = `🛍️ *NEW SHOPIFY ORDER* \`${orderNumber}\`\n\n`;
  msg += `👤 *Customer:* ${customerName}\n`;
  if (email) msg += `✉️ *Email:* ${email}\n`;
  if (phone) msg += `📞 *Phone:* ${phone}\n`;
  msg += `📍 *Ship To:* ${fullAddress}\n\n`;

  msg += `📦 *Items (${order.line_items?.length || 0}):*\n${itemsList}\n\n`;
  msg += `💰 *Total:* *${totalPrice}*\n`;
  msg += `💳 *Payment:* ${paymentDisplay}\n`;
  msg += `🚚 *Fulfillment:* ${fulfillmentStatus}\n`;

  if (order.note) {
    msg += `📝 *Order Note:* _${order.note}_\n`;
  }

  if (adminUrl) {
    msg += `\n🔗 ${adminUrl}`;
  }

  return msg;
}

/**
 * Initializes the WhatsApp connection using Baileys multi-device protocol
 */
export async function initWhatsApp() {
  if (!config.whatsapp.enabled) {
    console.log('ℹ️  WhatsApp integration is disabled (ENABLE_WHATSAPP is not true).');
    return null;
  }

  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_whatsapp');
    const { version } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }), // Suppress verbose internal socket logs
      printQRInTerminal: false, // We'll handle QR manually with styling
      browser: ['Telemation Bot', 'Desktop', '1.0.0'],
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n======================================================');
        console.log('📲  [WhatsApp] PLEASE SCAN THIS QR CODE WITH YOUR PHONE:');
        console.log('    1. Open WhatsApp on your phone');
        console.log('    2. Tap Settings (or 3 dots) > Linked Devices > Link a Device');
        console.log('======================================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\n======================================================\n');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`⚠️  [WhatsApp] Connection closed (Reason: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`);
        isConnecting = false;

        if (shouldReconnect) {
          setTimeout(() => initWhatsApp(), 5000);
        } else {
          console.log('❌ [WhatsApp] Session logged out. Please delete auth_whatsapp/ folder and re-scan.');
        }
      } else if (connection === 'open') {
        isConnecting = false;
        const userJid = waSocket.user?.id || '';
        const userNumber = userJid.split(':')[0] || userJid.split('@')[0];
        console.log(`✅ [WhatsApp] Connected successfully as +${userNumber}!`);

        // Discover and display user groups to make configuration effortless
        try {
          const groups = await waSocket.groupFetchAllParticipating();
          const groupList = Object.values(groups);
          if (groupList.length > 0) {
            console.log('\n📋 [WhatsApp Groups Available on your Account]:');
            groupList.forEach((g) => {
              const isSelected = g.id === config.whatsapp.groupId;
              console.log(`   ${isSelected ? '👉 [CONFIGURED]' : '  •'} "${g.subject}" -> ID: ${g.id}`);
            });
            if (!config.whatsapp.groupId) {
              console.log('\n💡 Tip: Copy your desired group ID above and paste it into WHATSAPP_GROUP_ID in your .env file!\n');
            } else {
              console.log('');
            }
          }
        } catch (err) {
          console.warn('Could not fetch WhatsApp group list:', err.message);
        }
      }
    });

    return waSocket;
  } catch (err) {
    isConnecting = false;
    console.error('❌ Failed to initialize WhatsApp client:', err);
    return null;
  }
}

/**
 * Sends a formatted order alert to the configured WhatsApp group
 */
export async function sendWhatsAppOrderAlert(order) {
  if (!config.whatsapp.enabled) {
    return;
  }

  if (!waSocket || !waSocket.user) {
    console.warn('⚠️  [WhatsApp] Cannot send alert: WhatsApp client is not logged in / connected.');
    return;
  }

  if (!config.whatsapp.groupId) {
    console.warn('⚠️  [WhatsApp] WHATSAPP_GROUP_ID is not configured in .env. Order alert skipped for WhatsApp.');
    return;
  }

  const messageText = formatWhatsAppOrder(order);

  return await waSocket.sendMessage(config.whatsapp.groupId, {
    text: messageText,
  });
}
