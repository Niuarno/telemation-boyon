import { config } from '../config.js';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Resolves an active access token, either from static config or via Client Credentials Grant
 */
async function getAccessToken() {
  const { adminAccessToken, clientId, clientSecret, shopDomain } = config.shopify;

  const isRealStaticToken = adminAccessToken && 
    !adminAccessToken.includes('your_admin_api_token') && 
    !adminAccessToken.includes('placeholder');

  // 1. If a real static Admin API access token (e.g. shpat_...) is provided
  if (isRealStaticToken) {
    return adminAccessToken;
  }

  // 2. If modern Dev Dashboard Client Credentials are provided
  if (clientId && clientSecret) {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
      return cachedToken;
    }

    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Client Credentials Token exchange failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 86400) * 1000;
    return cachedToken;
  }

  throw new Error('Shopify credentials missing. Configure SHOPIFY_ADMIN_API_ACCESS_TOKEN or (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET).');
}

/**
 * Helper to make authenticated requests to Shopify Admin REST API
 */
async function shopifyRequest(endpoint, queryParams = {}) {
  const { shopDomain, apiVersion } = config.shopify;

  if (!shopDomain) {
    throw new Error('Shopify store domain missing. Configure SHOPIFY_SHOP_DOMAIN.');
  }

  const token = await getAccessToken();

  const url = new URL(`https://${shopDomain}/admin/api/${apiVersion}/${endpoint}`);
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorJson;
    try {
      errorJson = JSON.parse(errorText);
    } catch {
      // not JSON
    }

    const message = errorJson?.errors || errorText || response.statusText;
    throw new Error(`Shopify API Error (${response.status}): ${typeof message === 'object' ? JSON.stringify(message) : message}`);
  }

  return response.json();
}

/**
 * Fetch the most recent orders from Shopify
 * @param {number} limit Number of orders to retrieve (default: 5, max: 20)
 */
export async function getRecentOrders(limit = 5) {
  const cappedLimit = Math.min(Math.max(1, limit), 20);
  const data = await shopifyRequest('orders.json', {
    status: 'any',
    limit: cappedLimit,
    fields: 'id,name,order_number,created_at,financial_status,fulfillment_status,total_price,currency,customer,line_items,shipping_address',
  });

  return data.orders || [];
}

/**
 * Retrieve a single order by its ID or order name (e.g. "1001" or "#1001")
 * @param {string|number} identifier 
 */
export async function getOrderByIdOrName(identifier) {
  const cleanQuery = String(identifier).trim();

  // If query is an exact Shopify ID (pure numeric and long, e.g. 5829104812)
  if (/^\d{8,}$/.test(cleanQuery)) {
    try {
      const data = await shopifyRequest(`orders/${cleanQuery}.json`);
      if (data?.order) return data.order;
    } catch (err) {
      // Fallback to name search if ID lookup fails
    }
  }

  // Otherwise search by order name (with or without '#')
  const orderName = cleanQuery.startsWith('#') ? cleanQuery : `#${cleanQuery}`;
  const data = await shopifyRequest('orders.json', {
    name: orderName,
    status: 'any',
    limit: 1,
  });

  if (data.orders && data.orders.length > 0) {
    return data.orders[0];
  }

  // If not found with '#', try without
  if (cleanQuery.startsWith('#')) {
    const withoutHash = cleanQuery.substring(1);
    const dataWithoutHash = await shopifyRequest('orders.json', {
      name: withoutHash,
      status: 'any',
      limit: 1,
    });
    if (dataWithoutHash.orders && dataWithoutHash.orders.length > 0) {
      return dataWithoutHash.orders[0];
    }
  }

  return null;
}
