# LeadForge AI

Local-business website auditor + lead CRM. Linear-style dark UI. Static site (GitHub Pages friendly) + one free Cloudflare Worker. Firebase for auth/CRM.

## What's real vs. not (read this)

| Feature | Status |
|---|---|
| Website audit (speed, mobile, SEO) | **Real** — Google PageSpeed Insights API (free, no billing) |
| Security/SSL/header checks, HTML parsing (forms, CTAs, meta, sitemap) | **Real** — via the Cloudflare Worker |
| Scoring, opportunity detection, confidence | **Real** — deterministic, computed from measured data (`scoring.js`) |
| Auth (email + Google), CRM, tags, notes, status, export | **Real** — Firebase + SheetJS |
| Executive summary + outreach points | Templated from real findings (swap for an LLM call if you add a key) |
| **Discovery** ("find local businesses, flag no-website ones") | **Real, free** — OpenStreetMap via Overpass + Nominatim, through the Worker. Coverage is **partial** (only businesses mapped in OSM) — a free lead source, not a complete market scan. |
| Full-coverage discovery ("every roofer in Miami") | **Not included** — needs a paid data API (Google Places w/ billing, or a B2B provider). Drop-in swap point. |

## Setup (all free)

### 1. Firebase
1. console.firebase.google.com → create project.
2. Authentication → enable **Email/Password** and **Google**.
3. Firestore Database → create (production mode is fine).
4. Project settings → Web app → copy the config into `firebaseConfig` in `index.html`.
5. Firestore rules — restrict leads to their owner:
```
rules_version='2';
service cloud.firestore{
  match /databases/{db}/documents{
    match /leads/{id}{
      allow read,write: if request.auth!=null && resource.data.uid==request.auth.uid;
      allow create: if request.auth!=null && request.resource.data.uid==request.auth.uid;
    }
  }
}
```

### 2. PageSpeed Insights key (optional, recommended)
console.cloud.google.com → APIs & Services → enable "PageSpeed Insights API" → create an API key. **No billing required.** Paste it in the app's Settings, or set it as the Worker's `PSI_KEY`.

### 3. Cloudflare Worker (gives you SSL/header/HTML audits)
1. dash.cloudflare.com → Workers & Pages → Create Worker.
2. Paste `worker.js`. Deploy.
3. (Optional) Settings → Variables → add `PSI_KEY`.
4. Copy the Worker URL into the app's Settings.

Without the Worker the app still runs in **PageSpeed-only mode** (no SSL/header/form checks, since browsers can't fetch other sites cross-origin).

### 4. Host the site
Push `index.html` + `scoring.js` to a GitHub repo → enable Pages. Add your Pages origin to the Worker's `ALLOWED_ORIGIN` for tighter CORS.

## Usage
**Discover** → enter city + industry → finds local businesses, pre-selects the no-website ones → "Add selected to leads." No-website businesses become greenfield leads (no audit — there's nothing to audit); businesses *with* a site get audited automatically on import.

**Audit** → paste businesses you already have URLs for (`Name, website` per line) → real PageSpeed + Worker audit.

Review everything in the **Leads** drawer (scores, findings, contact info, outreach). Export CSV/Excel.

## Worker endpoints
- `GET /audit?url=…` — full website audit (security + HTML + PageSpeed)
- `GET /discover?city=…&industry=…&radius=10&noWebsite=1` — OSM business discovery

## Discovery notes
- Data is OpenStreetMap (Overpass + Nominatim) — free, no key, no billing. Be a good citizen: it's rate-limited and shared infrastructure, so don't hammer it.
- Coverage varies by area and category. Missing businesses ≠ no businesses; they're just unmapped. Phone/email appear only when present in OSM tags.
- The Worker sends a `User-Agent` to Nominatim as its usage policy requires — keep it set.

## Files
- `index.html` — app (UI, auth, CRM, audit orchestration, charts, export)
- `scoring.js` — deterministic scoring engine
- `worker.js` — Cloudflare Worker (SSL/headers/HTML + PageSpeed proxy)

## Compliance notes
- Audits only sites you enter. Respect robots/ToS for any site you audit at volume; the Worker rate-limits naturally via PSI quotas.
- Collect only publicly listed contact info. Never fabricate owner names. Cold outreach: follow CAN-SPAM (US) and GDPR (EU) — get the basics right before sending anything.
