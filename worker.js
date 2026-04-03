/**
 * Domain Finder — Cloudflare Worker
 *
 * Deploy to Cloudflare Workers, then point your GitHub Pages site at it.
 * The worker proxies RDAP lookups server-side, avoiding CORS restrictions
 * and giving you a clean /api/check?domain=example.com endpoint.
 *
 * Deployment:
 *   1. Install Wrangler: npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler deploy
 *
 * Then set API_BASE in index.html to your worker's URL.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname !== '/api/check') {
      return new Response('Not found', { status: 404 });
    }

    const domain = url.searchParams.get('domain');
    if (!domain || !isValidDomain(domain)) {
      return json({ error: 'Invalid or missing domain parameter' }, 400);
    }

    try {
      // Use rdap.org as a universal bootstrap — it resolves the correct
      // authoritative RDAP registry per TLD automatically.
      const rdapRes = await fetch(`https://rdap.org/domain/${domain}`, {
        headers: { accept: 'application/rdap+json, application/json' },
        // Workers run at the edge; a 5-second timeout is generous.
        signal: AbortSignal.timeout(5000),
      });

      if (rdapRes.status === 404) {
        return json({
          domain,
          status: 'available',
          message: 'No registration record found via RDAP.',
        });
      }

      if (rdapRes.ok) {
        const data = await rdapRes.json().catch(() => ({}));
        const expiry = extractExpiry(data);
        return json({
          domain,
          status: 'taken',
          message: expiry ? `Registered — expires ${expiry}` : 'Registration record found.',
        });
      }

      // 400-range non-404 responses usually mean unsupported TLD
      if (rdapRes.status >= 400 && rdapRes.status < 500) {
        return json({
          domain,
          status: 'unknown',
          message: 'This TLD may not support RDAP lookups.',
        });
      }

      return json({
        domain,
        status: 'unknown',
        message: 'Registry returned an unexpected response.',
      });

    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      return json({
        domain,
        status: 'unknown',
        message: isTimeout ? 'Registry lookup timed out.' : 'Lookup failed.',
      });
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' },
  });
}

function isValidDomain(domain) {
  // Basic sanity check — not a full RFC validator
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/i.test(domain);
}

function extractExpiry(rdapData) {
  try {
    const event = rdapData.events?.find(e => e.eventAction === 'expiration');
    if (!event?.eventDate) return null;
    return new Date(event.eventDate).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return null;
  }
}
