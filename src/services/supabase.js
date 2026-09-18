import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from '../config.js';

let supabaseClient = null;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = config.supabase?.url;
  const key = config.supabase?.serviceRoleKey;

  if (!url || !key) {
    return null;
  }

  supabaseClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });

  return supabaseClient;
}

/**
 * Saves incoming Shopify order directly into Supabase (orders, order_items, upsell_rewards)
 * @param {Object} orderData Raw Shopify order object
 * @returns {Promise<{success: boolean, orderId?: string, error?: string}>}
 */
export async function saveOrderToSupabase(orderData) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('⚠️  [Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured. Skipping direct database save.');
    return { success: false, error: 'Supabase credentials not configured' };
  }

  try {
    const orderNumber = String(orderData.name || `#${orderData.order_number || orderData.id}`);

    // 1. Check for duplicate order
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('order_number', orderNumber)
      .maybeSingle();

    if (existingOrder) {
      console.log(`ℹ️  [Supabase] Order ${orderNumber} already exists in database (ID: ${existingOrder.id}).`);
      return { success: true, orderId: existingOrder.id };
    }

    // 2. Extract Customer details
    const cleanStr = (s) => (s && typeof s === 'string' && s.trim() !== '-' ? s.trim() : '');
    const noteName = orderData.note_attributes?.find((a) => /name/i.test(a.name))?.value;
    const firstName = cleanStr(orderData.customer?.first_name || orderData.shipping_address?.first_name);
    const lastName = cleanStr(orderData.customer?.last_name || orderData.shipping_address?.last_name);
    const customerName =
      [firstName, lastName].filter(Boolean).join(' ') ||
      cleanStr(orderData.shipping_address?.name) ||
      cleanStr(noteName) ||
      'Guest';

    // Phone
    const notePhone = orderData.note_attributes?.find((a) => /phone/i.test(a.name))?.value;
    const customerPhone =
      orderData.phone ||
      orderData.shipping_address?.phone ||
      orderData.customer?.phone ||
      notePhone ||
      'N/A';

    // Address
    const addr = orderData.shipping_address || orderData.billing_address || {};
    const noteAddress = orderData.note_attributes?.find((a) => /address/i.test(a.name))?.value;
    const addressParts = [];
    if (cleanStr(addr.address1) || cleanStr(noteAddress)) addressParts.push(cleanStr(addr.address1) || cleanStr(noteAddress));
    if (cleanStr(addr.address2)) addressParts.push(cleanStr(addr.address2));
    const city = cleanStr(addr.city);
    const country = cleanStr(addr.country);
    if (city || country) addressParts.push([city, country].filter(Boolean).join(', '));
    const shippingAddress = addressParts.join(', ') || 'No address provided';

    // Payment & Total
    const paymentMethod =
      orderData.payment_gateway_names?.length > 0
        ? orderData.payment_gateway_names.join(', ')
        : (orderData.gateway || 'Cash on Delivery (COD)');
    const paymentStatus = orderData.financial_status || 'pending';
    const totalAmount = parseFloat(orderData.total_price || orderData.current_total_price || '0');
    const currency = orderData.currency || orderData.presentment_currency || 'BDT';

    // 3. Extract Coupon Codes and Match Sales Rep
    const extractedCodes = [];
    if (Array.isArray(orderData.discount_codes)) {
      orderData.discount_codes.forEach((d) => {
        if (d?.code && typeof d.code === 'string') extractedCodes.push(d.code.trim());
      });
    }
    if (Array.isArray(orderData.discount_applications)) {
      orderData.discount_applications.forEach((d) => {
        if (d?.code && typeof d.code === 'string') extractedCodes.push(d.code.trim());
      });
    }
    if (Array.isArray(orderData.note_attributes)) {
      orderData.note_attributes.forEach((attr) => {
        if (/coupon|discount|promo|referral|sales_rep|rep_code/i.test(attr?.name || '') && attr?.value) {
          extractedCodes.push(String(attr.value).trim());
        }
      });
    }

    let salesRepId = null;
    let matchedCoupon = null;

    for (const code of extractedCodes) {
      if (!code) continue;
      const { data: rep } = await supabase
        .from('profiles')
        .select('id, coupon_code')
        .ilike('coupon_code', code)
        .maybeSingle();

      if (rep) {
        salesRepId = rep.id;
        matchedCoupon = rep.coupon_code || code;
        break;
      }
    }

    const finalCouponUsed = matchedCoupon || extractedCodes[0] || null;

    // 4. Insert Order
    const { data: newOrder, error: orderError } = await supabase
      .from('orders')
      .insert({
        order_number: orderNumber,
        source: 'website',
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_email: orderData.email || orderData.customer?.email || null,
        shipping_address: shippingAddress,
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        status: 'pending',
        total_amount: totalAmount,
        currency: currency,
        sales_rep_id: salesRepId,
        coupon_used: finalCouponUsed,
        note: orderData.note || null,
        external_id: String(orderData.id),
      })
      .select()
      .single();

    if (orderError || !newOrder) {
      throw orderError || new Error('Failed to insert order into Supabase');
    }

    // 5. Insert Order Items & Match Product Variants
    const lineItems = orderData.line_items || [];
    const itemsToInsert = [];

    for (const item of lineItems) {
      let matchedVariantId = null;
      let matchedProductId = null;

      if (item.sku) {
        const { data: v } = await supabase
          .from('product_variants')
          .select('id, product_id')
          .eq('sku', item.sku)
          .maybeSingle();
        if (v) {
          matchedVariantId = v.id;
          matchedProductId = v.product_id;
        }
      }

      if (!matchedVariantId) {
        const { data: v } = await supabase
          .from('product_variants')
          .select('id, product_id')
          .ilike('title', `%${item.variant_title || item.title}%`)
          .maybeSingle();
        if (v) {
          matchedVariantId = v.id;
          matchedProductId = v.product_id;
        }
      }

      itemsToInsert.push({
        order_id: newOrder.id,
        product_id: matchedProductId,
        variant_id: matchedVariantId,
        title: item.title || item.name || 'Item',
        variant_title: item.variant_title || null,
        quantity: parseInt(item.quantity, 10) || 1,
        price: parseFloat(item.price || '0'),
        is_upsell: false,
      });
    }

    if (itemsToInsert.length > 0) {
      await supabase.from('order_items').insert(itemsToInsert);
    }

    // 6. Calculate Sales Rep Commission / Reward (if attributed)
    if (salesRepId) {
      const { data: activeRule } = await supabase
        .from('reward_rules')
        .select('*')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

      if (activeRule) {
        let bonusAmount = 0;
        if (activeRule.rule_type === 'percentage') {
          bonusAmount = totalAmount * (activeRule.value / 100);
        } else if (activeRule.rule_type === 'fixed_per_order') {
          bonusAmount = activeRule.value;
        } else if (activeRule.rule_type === 'fixed_per_item') {
          const totalQty = itemsToInsert.reduce((sum, it) => sum + (it.quantity || 1), 0);
          bonusAmount = activeRule.value * totalQty;
        }

        if (bonusAmount > 0) {
          await supabase.from('upsell_rewards').insert({
            sales_rep_id: salesRepId,
            order_id: newOrder.id,
            bonus_amount: bonusAmount,
            status: 'pending',
            note: `Reward via coupon ${finalCouponUsed || 'matched'} (${activeRule.name})`,
          });
        }
      }
    }

    console.log(`✅ [Supabase] Order ${orderNumber} successfully saved to Supabase (ID: ${newOrder.id})`);
    return { success: true, orderId: newOrder.id };
  } catch (err) {
    console.error(`❌ [Supabase Save Error]: ${err.message}`);
    return { success: false, error: err.message };
  }
}
