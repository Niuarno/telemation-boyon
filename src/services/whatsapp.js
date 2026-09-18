import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getSupabaseClient } from './supabase.js';

export let waSocket = null;
let isConnecting = false;
let saveSessionTimeout = null;

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
 * Persists Baileys session files into Supabase (profiles table where role='admin')
 */
async function saveSessionToSupabase(authDir) {
  try {
    const credsPath = path.join(authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return;

    const supabase = getSupabaseClient();
    if (!supabase) return;

    const sessionFiles = {};
    const files = fs.readdirSync(authDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(authDir, file);
        const stat = fs.statSync(filePath);
        // Only include files under 50KB to keep storage lean
        if (stat.size < 50000) {
          sessionFiles[file] = fs.readFileSync(filePath, 'utf8');
        }
      }
    }

    const payload = JSON.stringify({
      prefix: 'BAILEYS_SESSION_V1',
      savedAt: new Date().toISOString(),
      files: sessionFiles,
    });

    const { error } = await supabase
      .from('profiles')
      .update({ bio: payload })
      .eq('role', 'admin');

    if (error) {
      console.error('❌ [WhatsApp] Failed to backup session to Supabase:', error.message);
    } else {
      console.log(`💾 [WhatsApp] Session backed up to Supabase (${Object.keys(sessionFiles).length} files saved).`);
    }
  } catch (err) {
    console.error('❌ [WhatsApp] Error backing up session to Supabase:', err.message);
  }
}

/**
 * Debounces session backups to prevent spamming Supabase during rapid handshakes
 */
function debouncedSaveSession(authDir) {
  if (saveSessionTimeout) clearTimeout(saveSessionTimeout);
  saveSessionTimeout = setTimeout(() => {
    saveSessionToSupabase(authDir);
  }, 2500);
}

/**
 * Restores WhatsApp session from Supabase into local auth directory
 */
async function restoreSessionFromSupabase(authDir) {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return false;

    const { data, error } = await supabase
      .from('profiles')
      .select('bio')
      .eq('role', 'admin')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error || !data?.bio) return false;

    let parsed;
    try {
      parsed = JSON.parse(data.bio);
    } catch {
      return false;
    }

    if (parsed && parsed.prefix === 'BAILEYS_SESSION_V1' && parsed.files) {
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }
      for (const [filename, content] of Object.entries(parsed.files)) {
        fs.writeFileSync(path.join(authDir, filename), content, 'utf8');
      }
      console.log(`✅ [WhatsApp] Successfully restored session (${Object.keys(parsed.files).length} files) from Supabase.`);
      return true;
    }
    return false;
  } catch (err) {
    console.error('⚠️  [WhatsApp] Failed to restore session from Supabase:', err.message);
    return false;
  }
}

/**
 * Clears stored WhatsApp session in Supabase when logged out
 */
async function clearSessionFromSupabase() {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    await supabase.from('profiles').update({ bio: null }).eq('role', 'admin');
    console.log('🧹 [WhatsApp] Stored session cleared from Supabase.');
  } catch (err) {
    console.error('⚠️  [WhatsApp] Failed to clear session from Supabase:', err.message);
  }
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
    const authDir = path.resolve('./auth_whatsapp');
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    // 1. Check local creds; if absent, restore from Supabase
    const credsPath = path.join(authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      await restoreSessionFromSupabase(authDir);
    }

    // 2. Fallback: restore from WHATSAPP_SESSION_BASE64 if still absent
    if (process.env.WHATSAPP_SESSION_BASE64 && !fs.existsSync(credsPath)) {
      try {
        const decoded = Buffer.from(process.env.WHATSAPP_SESSION_BASE64.trim(), 'base64').toString('utf8');
        fs.writeFileSync(credsPath, decoded, 'utf8');
        console.log('✅ [WhatsApp] Restored session from WHATSAPP_SESSION_BASE64.');
      } catch (err) {
        console.error('❌ [WhatsApp] Failed to parse WHATSAPP_SESSION_BASE64:', err.message);
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
    });

    // Save credentials whenever updated
    waSocket.ev.on('creds.update', async () => {
      await saveCreds();
      debouncedSaveSession(authDir);
    });

    // 3. If account is not registered yet, generate an 8-character Pairing Code!
    if (!waSocket.authState.creds.registered) {
      const rawPhone = config.whatsapp.phoneNumber || process.env.WHATSAPP_PHONE_NUMBER || '8801974962406';
      const cleanPhone = rawPhone.replace(/[^0-9]/g, '');

      setTimeout(async () => {
        try {
          if (!waSocket || waSocket.authState?.creds?.registered) return;
          const code = await waSocket.requestPairingCode(cleanPhone);
          console.log('\n======================================================');
          console.log('🔑 [WhatsApp] LINK YOUR DEVICE WITH THIS PAIRING CODE:');
          console.log(`\n             👉  ${code}  👈\n`);
          console.log('   Instructions:');
          console.log(`   1. Open WhatsApp on your phone (+${cleanPhone})`);
          console.log('   2. Go to Settings (or ⋮) > Linked Devices > Link a Device');
          console.log('   3. Tap "Link with phone number instead"');
          console.log(`   4. Enter code: ${code}`);
          console.log('======================================================\n');
        } catch (err) {
          console.error('❌ [WhatsApp] Failed to request pairing code:', err.message);
        }
      }, 4000);
    }

    // 4. Connection lifecycle handler
    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`⚠️  [WhatsApp] Connection closed (Reason: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`);
        isConnecting = false;

        if (shouldReconnect) {
          setTimeout(() => initWhatsApp(), 5000);
        } else {
          console.log('❌ [WhatsApp] Session logged out. Cleaning up credentials and requesting new pairing code...');
          try {
            if (fs.existsSync(authDir)) {
              fs.rmSync(authDir, { recursive: true, force: true });
            }
          } catch {}
          await clearSessionFromSupabase();
          setTimeout(() => initWhatsApp(), 3000);
        }
      } else if (connection === 'open') {
        isConnecting = false;
        const userJid = waSocket.user?.id || '';
        const userNumber = userJid.split(':')[0] || userJid.split('@')[0];
        console.log(`✅ [WhatsApp] Connected successfully as +${userNumber}!`);

        // Immediately persist the fresh session to Supabase
        await saveSessionToSupabase(authDir);

        // Discover and display user groups
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

  try {
    const res = await waSocket.sendMessage(config.whatsapp.groupId, {
      text: messageText,
    });
    console.log(`✅ [WhatsApp] Order alert dispatched for ${order.name || order.id}`);
    return res;
  } catch (err) {
    console.error(`❌ [WhatsApp] Failed to send order alert:`, err.message);
    throw err;
  }
}
