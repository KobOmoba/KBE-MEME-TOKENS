/**
 * Helius API — token metadata and security data.
 * Provides: mint authority, freeze authority, social links, holder data.
 * Falls back gracefully if Helius key not set.
 */

const cfg = require('../../config');
const log = require('../utils/logger').forTag('HELIUS');

const BASE = 'https://api.helius.xyz/v0';

const deadPaths = new Set();   // endpoints Helius has retired (HTTP 410/404): stop calling them

async function heliusGet(path, params = {}) {
  if (deadPaths.has(path)) return null;
  if (!cfg.heliusApiKey) {
    log.warn('HELIUS_API_KEY not set — security enrichment unavailable');
    return null;
  }
  try {
    const query = new URLSearchParams({ 'api-key': cfg.heliusApiKey, ...params });
    const resp  = await fetch(`${BASE}${path}?${query}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) {
      if (resp.status === 410 || resp.status === 404) {
        deadPaths.add(path);
        log.warn(`Helius ${path} is retired (HTTP ${resp.status}) — disabled for this session; Pump.fun mint/freeze authority assumed revoked`);
        return null;
      }
      log.warn(`Helius ${path} returned HTTP ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    log.warn(`Helius request failed (${path}):`, err.message);
    return null;
  }
}

/**
 * Get token security info: mint authority, freeze authority, supply.
 * Returns { mintAuthorityRevoked, freezeAuthorityRevoked } or defaults.
 */
async function getTokenSecurity(mintAddress) {
  const data = await heliusGet(`/token-metadata`, { mint: mintAddress });
  if (!data || !data[0]) {
    // Fail safe: for Pump.fun tokens, mint/freeze are ALWAYS revoked at launch.
    // But we note it wasn't confirmed.
    return {
      mintAuthorityRevoked:   true,   // Pump.fun guarantee
      freezeAuthorityRevoked: true,   // Pump.fun guarantee
      confirmed:              false,
    };
  }

  const meta = data[0];
  return {
    mintAuthorityRevoked:   meta.onChainMetadata?.metadata?.data?.mintAuthority === null
                         || meta.onChainMetadata?.metadata?.mint?.mintAuthority === null,
    freezeAuthorityRevoked: meta.onChainMetadata?.metadata?.mint?.freezeAuthority === null,
    name:    meta.onChainMetadata?.metadata?.data?.name   || '',
    symbol:  meta.onChainMetadata?.metadata?.data?.symbol || '',
    uri:     meta.onChainMetadata?.metadata?.data?.uri    || '',
    confirmed: true,
  };
}

/**
 * Get token metadata and social links from URI.
 */
async function getTokenMeta(mintAddress) {
  const sec = await getTokenSecurity(mintAddress);
  let social = { hasTwitter: false, hasTelegram: false, hasWebsite: false };

  // If we have a URI, try to fetch the JSON metadata for social links
  if (sec?.uri) {
    try {
      const resp = await fetch(sec.uri, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
        const metaJson = await resp.json();
        const ext = metaJson?.extensions || metaJson?.properties || {};
        social.hasTwitter  = !!(ext.twitter || metaJson.twitter);
        social.hasTelegram = !!(ext.telegram || metaJson.telegram);
        social.hasWebsite  = !!(ext.website  || metaJson.website);
      }
    } catch (_) {
      // Social data unavailable — not a red flag
    }
  }

  return { ...sec, ...social };
}

module.exports = { getTokenSecurity, getTokenMeta };
