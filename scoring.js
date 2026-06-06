/* LeadForge AI — Deterministic scoring engine.
   Turns raw worker output into 0–10 dimension scores + findings.
   No AI invents these numbers; they derive from measured signals. */

const clamp10 = n => Math.max(0, Math.min(10, Math.round(n)));

function scoreSpeed(psiMobile) {
  if (!psiMobile?.available || psiMobile.performance == null) return { score: null, why: 'No PageSpeed data' };
  // Lighthouse perf 0–100 → 0–10, with LCP penalty surfaced as a finding elsewhere.
  return { score: clamp10(psiMobile.performance / 10), why: `Lighthouse performance ${psiMobile.performance}/100` };
}

function scoreMobile(psiMobile, html) {
  let s = 0, why = [];
  if (psiMobile?.viewportPass || html?.hasViewport) { s += 5; why.push('viewport configured'); }
  else why.push('no responsive viewport meta');
  if (psiMobile?.available && psiMobile.performance != null) {
    s += clamp10(psiMobile.performance / 10) / 2; // mobile perf contributes
  }
  if (psiMobile?.cls != null && psiMobile.cls < 0.1) { s += 2; why.push('stable layout'); }
  return { score: clamp10(s), why: why.join(', ') };
}

function scoreSeo(psiMobile, html) {
  if (psiMobile?.available && psiMobile.seo != null) {
    // Trust Lighthouse SEO, nudged by our own title/meta/h1 checks.
    let s = psiMobile.seo / 10;
    if (!html?.title) s -= 1.5;
    if (!html?.metaDescription) s -= 1;
    if (html?.h1Count === 0) s -= 1;
    if (html?.hasSitemap) s += 0.5;
    return { score: clamp10(s), why: `Lighthouse SEO ${psiMobile.seo}/100` };
  }
  // Fallback: pure HTML heuristics
  let s = 2;
  if (html?.title && html.titleLen >= 20 && html.titleLen <= 65) s += 2;
  if (html?.metaDescription && html.metaDescLen >= 50) s += 2;
  if (html?.h1Count >= 1) s += 2;
  if (html?.hasJsonLd) s += 1;
  if (html?.hasSitemap) s += 1;
  return { score: clamp10(s), why: 'HTML heuristics (no PSI)' };
}

function scoreSecurity(sec) {
  let s = 0, why = [];
  if (sec?.https && sec.validTls) { s += 5; why.push('valid HTTPS'); } else why.push('no/invalid HTTPS');
  if (sec?.redirectsToHttps) s += 1;
  if (sec?.hsts) { s += 1; why.push('HSTS'); }
  if (sec?.csp) { s += 1; why.push('CSP'); }
  if (sec?.xfo) s += 0.5;
  if (sec?.xcto) s += 0.5;
  if (sec?.referrerPolicy) s += 1;
  return { score: clamp10(s), why: why.join(', ') };
}

function scoreConversion(html) {
  let s = 0, why = [];
  if (html?.formCount > 0) { s += 3; why.push(`${html.formCount} form(s)`); } else why.push('no contact form');
  if (html?.bookingWidget) { s += 3; why.push(`${html.bookingWidget} booking`); }
  if (html?.hasTel) { s += 1.5; why.push('click-to-call'); }
  if (html?.hasMailto) s += 0.5;
  if (html?.ctaCount >= 2) { s += 2; why.push('clear CTAs'); }
  else if (html?.ctaCount === 1) s += 1;
  return { score: clamp10(s), why: why.join(', ') || 'minimal conversion paths' };
}

function scoreDesign(psiMobile, html) {
  // Most subjective + least defensible → lowest weight. Proxy via best-practices + accessibility.
  if (psiMobile?.available && (psiMobile.bestPractices != null || psiMobile.accessibility != null)) {
    const bp = psiMobile.bestPractices ?? 50;
    const a11y = psiMobile.accessibility ?? 50;
    return { score: clamp10((bp * 0.5 + a11y * 0.5) / 10), why: `best-practices ${bp}, a11y ${a11y}` };
  }
  let s = 4;
  if (html?.hasViewport) s += 2;
  if (html?.bytes && html.bytes < 500000) s += 1;
  return { score: clamp10(s), why: 'limited signals' };
}

const WEIGHTS = { conversion: 0.25, speed: 0.20, mobile: 0.20, seo: 0.15, design: 0.10, security: 0.10 };

function ratingFor(score) {
  if (score >= 8.5) return 'EXCELLENT';
  if (score >= 7) return 'GOOD';
  if (score >= 5) return 'AVERAGE';
  if (score >= 3) return 'POOR';
  return 'CRITICAL';
}

function buildFindings(s, sec, html, psi) {
  const f = [];
  const add = (label, severity, detail) => f.push({ label, severity, detail });
  if (s.security < 5) add('No / weak HTTPS & security headers', 'critical', sec?.why || '');
  if (s.speed != null && s.speed < 5) add('Slow loading homepage', 'high',
    psi?.mobile?.lcpMs ? `Mobile LCP ~${Math.round(psi.mobile.lcpMs)}ms` : 'Low Lighthouse performance');
  if (s.mobile < 5) add('Poor mobile experience', 'high', html?.hasViewport ? '' : 'No responsive viewport');
  if (s.conversion < 5) add('Weak conversion funnel', 'high',
    !html?.formCount ? 'No contact form detected' : 'Few conversion paths');
  if (!html?.bookingWidget && !html?.formCount) add('No online booking or quote form', 'high', '');
  if (s.seo < 5) add('Weak SEO structure', 'medium',
    [!html?.title && 'missing title', !html?.metaDescription && 'no meta description',
     html?.h1Count === 0 && 'no H1'].filter(Boolean).join(', '));
  if (s.design < 5) add('Outdated / inconsistent design signals', 'medium', '');
  if (!f.length) add('No major issues detected', 'low', 'Site performs well across checks');
  return f;
}

function computeAudit(raw) {
  const { security: sec, html, psi } = raw;
  const m = psi?.mobile;
  const dims = {
    speed: scoreSpeed(m),
    mobile: scoreMobile(m, html),
    seo: scoreSeo(m, html),
    design: scoreDesign(m, html),
    conversion: scoreConversion(html),
    security: scoreSecurity(sec),
  };
  const s = Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, v.score ?? 5]));
  const overall = Object.entries(WEIGHTS).reduce((acc, [k, w]) => acc + s[k] * w, 0);
  const findings = buildFindings(s, sec, html, psi);
  // Confidence: how much real data backed the scores.
  let conf = 40;
  if (m?.available) conf += 35;
  if (!html?.error) conf += 15;
  if (!sec?.error) conf += 10;
  return {
    scores: s, dimDetail: dims,
    overall: Math.round(overall * 10) / 10,
    rating: ratingFor(overall),
    findings,
    confidence: Math.min(100, conf),
    raw,
  };
}

window.LeadForgeScoring = { computeAudit, ratingFor, WEIGHTS };
