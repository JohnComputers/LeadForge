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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const { pathname, searchParams } = new URL(request.url);
    if (pathname !== '/audit') return json({ error: 'not found' }, 404);

    const url = normalizeUrl(searchParams.get('url'));
    if (!url) return json({ error: 'invalid url' }, 400);

    const key = env?.PSI_KEY || null;
    const [security, html, mobile, desktop] = await Promise.all([
      checkSecurity(url),
      checkHtml(url),
      runPsi(url, 'mobile', key),
      runPsi(url, 'desktop', key),
    ]);

    return json({ url, fetchedAt: new Date().toISOString(), security, html, psi: { mobile, desktop } });
  },
};
