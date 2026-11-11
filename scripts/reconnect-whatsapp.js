import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const authDir = path.resolve('./auth_whatsapp');

console.log('======================================================');
console.log('🔄 [WhatsApp Reconnect] Resetting session credentials...');
console.log('======================================================');

// 1. Remove local auth_whatsapp folder
if (fs.existsSync(authDir)) {
  try {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('✅ Cleared local ./auth_whatsapp directory.');
  } catch (err) {
    console.warn('⚠️ Could not remove local auth_whatsapp directory:', err.message);
  }
}

// 2. Remove stale session backup from Supabase via direct REST fetch (no WebSocket dependencies)
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (supabaseUrl && supabaseKey) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.whatsapp_session`, {
      method: 'DELETE',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (res.ok) {
      console.log('✅ Cleared stale session from Supabase system_settings.');
    } else {
      console.warn(`⚠️ Supabase returned HTTP ${res.status} while clearing session.`);
    }

    // Also clean any legacy bio
    await fetch(`${supabaseUrl}/rest/v1/profiles?bio=ilike.*BAILEYS_SESSION*`, {
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bio: null }),
    }).catch(() => {});
  } catch (err) {
    console.warn('⚠️ Could not clear Supabase session:', err.message);
  }
}

console.log('\n🚀 Starting Telemation server to generate your fresh pairing code...\n');

// 3. Launch Telemation server
await import('../src/server.js');
