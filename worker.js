/**
 * LeadForge AI — Audit Worker (Cloudflare Workers, free tier)
 *
 * Deploy: paste into a new Worker at dash.cloudflare.com (Workers & Pages → Create).
 * Set an env var PSI_KEY = your free PageSpeed Insights API key (optional but recommended).
 *
 * Endpoints:
 *   GET /audit?url=https://example.com
 *     → { url, security:{...}, html:{...}, psi:{ mobile, desktop } }
 *
 * Does the things a browser cannot do cross-origin:
 *   - follow redirects / detect HTTPS upgrade
 *   - read response security headers + TLS validity
 *   - fetch and parse raw HTML (title, meta, h1, sitemap, json-ld, forms, CTAs)
 *   - call PageSpeed Insights server-side and return real Lighthouse category scores
 */

const ALLOWED_ORIGIN = '*'; // tighten to your GitHub Pages origin in production

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    ...extra,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors() });
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return null; }
}

async function checkSecurity(url) {
  const out = {
    https: false, redirectsToHttps: false, validTls: false,
    hsts: false, csp: false, xfo: false, xcto: false, referrerPolicy: false,
    finalUrl: null, error: null,
  };
  try {
    // Try the http version to see if it upgrades.
    const httpUrl = url.replace(/^https:/, 'http:');
    let upgraded = false;
    try {
      const r0 = await fetch(httpUrl, { method: 'HEAD', redirect: 'manual' });
      const loc = r0.headers.get('location') || '';
      if (r0.status >= 300 && r0.status < 400 && loc.startsWith('https:')) upgraded = true;
    } catch { /* ignore */ }

    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    out.finalUrl = res.url;
    out.https = res.url.startsWith('https:');
    out.validTls = out.https; // reaching it over https without fetch throwing ⇒ cert chain valid
    out.redirectsToHttps = upgraded || out.https;
    const h = res.headers;
    out.hsts = !!h.get('strict-transport-security');
    out.csp = !!h.get('content-security-policy');
    out.xfo = !!h.get('x-frame-options');
    out.xcto = (h.get('x-content-type-options') || '').toLowerCase().includes('nosniff');
    out.referrerPolicy = !!h.get('referrer-policy');
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

async function checkHtml(url) {
  const out = {
    title: null, titleLen: 0, metaDescription: null, metaDescLen: 0,
    h1Count: 0, hasViewport: false, hasJsonLd: false, hasSitemap: false,
    formCount: 0, hasMailto: false, hasTel: false, bookingWidget: null,
    ctaCount: 0, bytes: 0, error: null,
  };
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const html = await res.text();
    out.bytes = html.length;
    const lower = html.toLowerCase();

    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (title) { out.title = title[1].trim().slice(0, 200); out.titleLen = out.title.length; }

    const md = html.match(/<meta[^>]+name=["']description["'][^>]*>/i);
    if (md) {
      const c = md[0].match(/content=["']([\s\S]*?)["']/i);
      if (c) { out.metaDescription = c[1].trim().slice(0, 300); out.metaDescLen = out.metaDescription.length; }
    }

    out.h1Count = (html.match(/<h1[\s>]/gi) || []).length;
    out.hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    out.hasJsonLd = /application\/ld\+json/i.test(html);
    out.formCount = (html.match(/<form[\s>]/gi) || []).length;
    out.hasMailto = /href=["']mailto:/i.test(html);
    out.hasTel = /href=["']tel:/i.test(html);

    if (lower.includes('calendly.com')) out.bookingWidget = 'Calendly';
    else if (lower.includes('acuityscheduling') || lower.includes('squarespace-scheduling')) out.bookingWidget = 'Acuity';
    else if (lower.includes('housecallpro') || lower.includes('jobber') || lower.includes('servicetitan')) out.bookingWidget = 'FieldServiceTool';

    const ctaWords = ['get a quote', 'free quote', 'request a quote', 'book now', 'schedule',
      'contact us', 'get started', 'call now', 'request service', 'estimate'];
    out.ctaCount = ctaWords.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);

    // sitemap probe (best-effort, cheap)
    try {
      const su = new URL('/sitemap.xml', res.url).toString();
      const sm = await fetch(su, { method: 'HEAD' });
      out.hasSitemap = sm.ok;
    } catch { /* ignore */ }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

async function runPsi(url, strategy, key) {
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  ['performance', 'seo', 'accessibility', 'best-practices'].forEach(c => api.searchParams.append('category', c));
  if (key) api.searchParams.set('key', key);
  try {
    const res = await fetch(api.toString());
    if (!res.ok) return { error: `PSI ${res.status}`, available: false };
    const data = await res.json();
    const cats = data.lighthouseResult?.categories || {};
    const audits = data.lighthouseResult?.audits || {};
    const pct = c => (cats[c]?.score != null ? Math.round(cats[c].score * 100) : null);
    return {
      available: true,
      performance: pct('performance'),
      seo: pct('seo'),
      accessibility: pct('accessibility'),
      bestPractices: pct('best-practices'),
      lcpMs: audits['largest-contentful-paint']?.numericValue ?? null,
      tbtMs: audits['total-blocking-time']?.numericValue ?? null,
      cls: audits['cumulative-layout-shift']?.numericValue ?? null,
      totalBytes: audits['total-byte-weight']?.numericValue ?? null,
      viewportPass: audits['viewport']?.score === 1,
    };
  } catch (e) {
    return { error: String(e), available: false };
  }
}

/* =====================================================================
   DISCOVERY — OpenStreetMap via Overpass API (free, no key, legal).
   Finds local businesses by category near a city, and flags which ones
   have NO website tag (= "needs a website" leads).
======================================================================*/

// Map friendly industries → OSM tag filters.
// Each entry is a list of [key, value] OSM tag pairs to match (OR).
const OSM_CATEGORIES = {
  'Roofing':       [['craft','roofer'], ['shop','roofing']],
  'HVAC':          [['craft','hvac'], ['trade','hvac'], ['craft','heating_engineer']],
  'Plumbing':      [['craft','plumber'], ['shop','plumber']],
  'Landscaping':   [['craft','gardener'], ['landuse','landscaping'], ['shop','garden_centre']],
  'Tree Services': [['craft','gardener']],
  'Auto Repair':   [['shop','car_repair'], ['craft','car_repair']],
  'Restaurants':   [['amenity','restaurant'], ['amenity','fast_food'], ['amenity','cafe']],
  'Dentists':      [['amenity','dentist'], ['healthcare','dentist']],
  'Law Firms':     [['office','lawyer'], ['office','notary']],
  'Electrician':   [['craft','electrician']],
  'Other':         [['shop','yes']],
};

// Geocode a city name → {lat, lon, bbox} using Nominatim (also free, OSM).
async function geocodeCity(city) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', city);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '1');
  const res = await fetch(u.toString(), {
    headers: { 'User-Agent': 'LeadForgeAI/1.0 (lead discovery tool)' },
  });
  if (!res.ok) throw new Error('geocode failed ' + res.status);
  const arr = await res.json();
  if (!arr.length) return null;
  const g = arr[0];
  return { lat: parseFloat(g.lat), lon: parseFloat(g.lon), displayName: g.display_name };
}

function buildOverpassQuery(filters, lat, lon, radiusMeters) {
  // Build an Overpass QL union over nodes+ways for each tag filter, around a point.
  const around = `(around:${radiusMeters},${lat},${lon})`;
  const parts = [];
  for (const [k, v] of filters) {
    parts.push(`node["${k}"="${v}"]${around};`);
    parts.push(`way["${k}"="${v}"]${around};`);
  }
  return `[out:json][timeout:25];(${parts.join('')});out center tags 200;`;
}

function normalizeOsmElement(el) {
  const t = el.tags || {};
  const name = t.name || t['name:en'] || null;
  if (!name) return null; // unnamed POIs are useless as leads
  const website = t.website || t['contact:website'] || t.url || null;
  const phone = t.phone || t['contact:phone'] || t['contact:mobile'] || null;
  const email = t.email || t['contact:email'] || null;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const address = [street, t['addr:city'], t['addr:postcode']].filter(Boolean).join(', ') || null;
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  return {
    osmId: `${el.type}/${el.id}`,
    name,
    website,
    hasWebsite: !!website,
    phone,
    email,
    address,
    lat, lon,
    facebook: t['contact:facebook'] || null,
    instagram: t['contact:instagram'] || null,
  };
}

async function discover(city, industry, radiusMeters, onlyNoWebsite) {
  const geo = await geocodeCity(city);
  if (!geo) return { error: 'Could not find that city', results: [] };

  const filters = OSM_CATEGORIES[industry] || OSM_CATEGORIES['Other'];
  const ql = buildOverpassQuery(filters, geo.lat, geo.lon, radiusMeters);

  // Try a couple of Overpass mirrors for resilience.
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let data = null, lastErr = null;
  for (const m of mirrors) {
    try {
      const res = await fetch(m, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
      });
      if (res.ok) { data = await res.json(); break; }
      lastErr = 'Overpass ' + res.status;
    } catch (e) { lastErr = String(e); }
  }
  if (!data) return { error: lastErr || 'Overpass unavailable', results: [] };

  const seen = new Set();
  let results = (data.elements || [])
    .map(normalizeOsmElement)
    .filter(Boolean)
    .filter(r => { const k = r.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  if (onlyNoWebsite) results = results.filter(r => !r.hasWebsite);

  return {
    city: geo.displayName,
    industry,
    total: results.length,
    noWebsiteCount: results.filter(r => !r.hasWebsite).length,
    results,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const { pathname, searchParams } = new URL(request.url);

    if (pathname === '/audit') {
      const url = normalizeUrl(searchParams.get('url'));
      if (!url) return json({ error: 'invalid url' }, 400);
      const key = env?.PSI_KEY || searchParams.get('psiKey') || null;
      const [security, html, mobile, desktop] = await Promise.all([
        checkSecurity(url),
        checkHtml(url),
        runPsi(url, 'mobile', key),
        runPsi(url, 'desktop', key),
      ]);
      return json({ url, fetchedAt: new Date().toISOString(), security, html, psi: { mobile, desktop } });
    }

    if (pathname === '/discover') {
      const city = (searchParams.get('city') || '').trim();
      const industry = searchParams.get('industry') || 'Other';
      const radiusMi = parseFloat(searchParams.get('radius') || '10');
      const onlyNoWebsite = searchParams.get('noWebsite') === '1';
      if (!city) return json({ error: 'city required' }, 400);
      const radiusMeters = Math.min(80000, Math.max(1000, radiusMi * 1609));
      try {
        const out = await discover(city, industry, radiusMeters, onlyNoWebsite);
        return json(out);
      } catch (e) {
        return json({ error: String(e.message || e), results: [] }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
