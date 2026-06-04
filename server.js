/*
 * =============================================================================
 *  PulseLab — Single-User Web Performance Lab
 * =============================================================================
 *  A local tool that measures how fast a web page feels for ONE real visitor
 *  and explains every number in plain English.
 *
 *  Three engines:
 *    - Lighthouse   : Google's lab audit (0-100 scores + opportunities)
 *    - Playwright   : drives a real browser through multi-step journeys/logins
 *    - Chrome (CDP) : live FCP/LCP/CLS, timing, request waterfall, screenshot
 *
 *  No LLM. Runs entirely offline. The UI lives in public/index.html.
 *
 *  HTTP API
 *    GET  /                 the single-page app
 *    GET  /api/state        engine status + thresholds + flows + history
 *    POST /api/audit        audit one URL          { url, device, throttling }
 *    POST /api/traverse     audit a saved flow     { flow, device }
 *    GET  /api/thresholds   read the SLO bands
 *    POST /api/thresholds   save the SLO bands     { thresholds }
 *    GET  /api/history      past runs
 *    GET  /reports          saved Lighthouse HTML reports
 * =============================================================================
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const chromeLauncher = require('chrome-launcher');
// lighthouse 12+ is ESM — its callable is the default export.
const lighthouse = (await import('lighthouse')).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const FLOWS_DIR = path.join(__dirname, 'flows');
const REPORTS_DIR = path.join(__dirname, 'reports');
const DATA_DIR = path.join(__dirname, 'data');
const THRESHOLDS_FILE = path.join(DATA_DIR, 'thresholds.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

for (const dir of [REPORTS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// One-time migration: older history entries were saved before runs had a stable
// `id`. Backfill ids so those runs can be deleted/compared from the UI too.
(function backfillHistoryIds() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    let changed = false;
    for (const run of history) {
      if (!run.id) {
        run.id = `${Date.parse(run.date) ? Date.parse(run.date).toString(36) : Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (_) { /* non-fatal */ }
})();

let auditRunning = false; // single-user lock: only one audit/traversal at a time
// Live progress for the running flow — polled by the Audit page to stream the
// browser view + step log while the journey runs.
let LIVE = { running: false, flow: null, steps: [], current: null, shot: null };
function liveReset(flow) { LIVE = { running: true, flow: flow || null, steps: [], current: null, shot: null }; }
function liveStep(name, url, shot) { LIVE.current = name; LIVE.steps.push({ name, url, at: Date.now() }); if (shot) LIVE.shot = shot; }

// =============================================================================
//  THRESHOLDS (SLOs)
//  The single source of truth for the Good / Needs-work / Poor colour bands
//  shown across the UI. Defaults are the standard Web Vitals + Chrome cutoffs.
// =============================================================================
const DEFAULT_THRESHOLDS = {
  score:         { good: 90,   ni: 50,   unit: '',   label: 'Lighthouse perf score',         note: 'Higher is better; above Good = green.' },
  lcp:           { good: 2500, ni: 4000, unit: 'ms', label: 'Largest Contentful Paint (LCP)', note: 'Largest above-the-fold paint.' },
  fcp:           { good: 1800, ni: 3000, unit: 'ms', label: 'First Contentful Paint (FCP)',   note: 'Time to first non-blank pixel.' },
  cls:           { good: 0.1,  ni: 0.25, unit: '',   label: 'Cumulative Layout Shift (CLS)',  note: 'Unitless. Lower is better.' },
  tbt:           { good: 200,  ni: 600,  unit: 'ms', label: 'Total Blocking Time (TBT)',      note: 'Main-thread blocking after FCP.' },
  ttfb:          { good: 800,  ni: 1800, unit: 'ms', label: 'Time to First Byte (TTFB)',      note: 'Server response latency.' },
  pageLoad:      { good: 3400, ni: 5800, unit: 'ms', label: 'Page load (DCL to load)',        note: 'Document load wall-clock.' },
  requests:      { good: 50,   ni: 100,  unit: '',   label: 'Total network requests',         note: 'Per page.' },
  transferKb:    { good: 1500, ni: 3000, unit: 'KB', label: 'Bytes transferred',              note: 'Payload across all requests.' },
  consoleErrors: { good: 0,    ni: 3,    unit: '',   label: 'Console errors',                 note: 'Good = 0; Poor = 3 or more.' },
};

function readThresholds() {
  const saved = readJson(THRESHOLDS_FILE, null);
  if (!saved) return DEFAULT_THRESHOLDS;
  // Merge so newly added default keys still appear on top of an old saved file.
  const merged = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    merged[key] = { ...DEFAULT_THRESHOLDS[key], ...(saved[key] || {}) };
  }
  return merged;
}

// =============================================================================
//  METRIC DICTIONARY
//  Plain-English explanation of each metric (shown on hover in the UI), plus
//  the mapping from our short keys to Lighthouse's audit ids.
// =============================================================================
const METRICS = {
  lcp:  { label: 'LCP',  lhId: 'largest-contentful-paint', what: 'Time until the biggest thing on screen (hero image / headline) is fully shown.',           why: 'The moment the page looks "ready" — the headline speed number.' },
  fcp:  { label: 'FCP',  lhId: 'first-contentful-paint',   what: 'Time until the first piece of content appears.',                                            why: 'A blank screen feels broken; first paint shows it is working.' },
  cls:  { label: 'CLS',  lhId: 'cumulative-layout-shift',  what: 'How much the page jumps around while loading.',                                             why: 'Unexpected movement causes mis-taps. 0 = nothing moved.' },
  tbt:  { label: 'TBT',  lhId: 'total-blocking-time',      what: 'How long the page was frozen and could not respond to clicks while loading code.',          why: 'A page can look ready but ignore clicks — feels unresponsive.' },
  si:   { label: 'SI',   lhId: 'speed-index',              what: 'How quickly the page visually fills in from blank to complete.',                            why: 'Captures the overall "it loaded fast" feeling.' },
  tti:  { label: 'TTI',  lhId: 'interactive',              what: 'Time until the page is fully usable — every button reliably responds.',                     why: 'When the user can actually start doing things.' },
  ttfb: { label: 'TTFB', lhId: 'server-response-time',     what: 'Time for the server to send the first byte of the page.',                                   why: 'High TTFB = a slow backend before the browser can even start.' },
};

const LH_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

// =============================================================================
//  SCORING HELPERS
// =============================================================================

// A 0..1 Lighthouse score -> a band level used for colour + label.
function scoreBand(score) {
  if (score == null) return 'na';
  if (score >= 0.9) return 'good';
  if (score >= 0.5) return 'average';
  return 'poor';
}

// A raw metric value vs. its threshold -> band level. Lower is better for every
// metric except `score`, which is higher-is-better.
function valueBand(key, value, thresholds) {
  const t = thresholds[key];
  if (!t || value == null) return 'na';
  if (key === 'score') return value >= t.good ? 'good' : value >= t.ni ? 'average' : 'poor';
  return value <= t.good ? 'good' : value <= t.ni ? 'average' : 'poor';
}

function verdict(perfScore) {
  if (perfScore == null) return 'We could not measure performance for this page.';
  if (perfScore >= 90) return 'Fast for a single visitor. Most users will have a smooth experience.';
  if (perfScore >= 50) return 'Okay but has room to improve. Some users will notice waiting.';
  return 'Slow for a single visitor. Users are likely to wait noticeably and may leave.';
}

// Rule-based "insights" (no LLM): concrete fixes derived from the real audit.
function buildInsights(metrics, lhr) {
  const tips = [];
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
  const bad = (k) => byKey[k] && byKey[k].level !== 'good';

  if (bad('lcp'))  tips.push('LCP is high — the main image/headline takes too long. Compress the hero image, preload it, and avoid lazy-loading above the fold.');
  if (bad('tbt'))  tips.push('TBT is high — too much JavaScript blocks the main thread. Split bundles, defer non-critical scripts, and remove unused code.');
  if (bad('cls'))  tips.push('CLS is high — content shifts as it loads. Set explicit width/height on images and reserve space for ads/embeds.');
  if (bad('fcp'))  tips.push('FCP is slow — first paint is delayed. Reduce render-blocking CSS/JS and improve server response (TTFB).');

  // Top Lighthouse opportunities, by estimated time saved.
  Object.values(lhr.audits)
    .filter((a) => a.details?.type === 'opportunity' && a.details.overallSavingsMs > 0)
    .sort((a, b) => b.details.overallSavingsMs - a.details.overallSavingsMs)
    .slice(0, 3)
    .forEach((a) => tips.push(`${a.title} (save ~${Math.round(a.details.overallSavingsMs)} ms)`));

  if (!tips.length) tips.push('No significant performance problems found for a single visitor. Good job!');
  return tips;
}

// Explained core metrics extracted from a Lighthouse result.
function extractMetrics(lhr) {
  const out = [];
  for (const [key, info] of Object.entries(METRICS)) {
    const audit = lhr.audits[info.lhId];
    if (!audit) continue;
    out.push({
      key,
      label: info.label,
      value: audit.displayValue || 'n/a',
      numeric: audit.numericValue ?? null,
      score: audit.score == null ? null : Math.round(audit.score * 100),
      level: scoreBand(audit.score),
      what: info.what,
      why: info.why,
    });
  }
  return out;
}

function extractCategories(lhr) {
  const cats = lhr.categories || {};
  return LH_CATEGORIES
    .filter((k) => cats[k])
    .map((k) => ({
      key: k,
      label: cats[k].title,
      score: Math.round((cats[k].score ?? 0) * 100),
      level: scoreBand(cats[k].score),
    }));
}

// Which Lighthouse category each audit belongs to (for the table's Category col).
function auditCategory(lhr, auditId) {
  for (const [key, cat] of Object.entries(lhr.categories || {})) {
    if ((cat.auditRefs || []).some((r) => r.id === auditId)) return cat.title || key;
  }
  return '';
}

// Failing audits / opportunities for the Lighthouse tab table.
function extractOpportunities(lhr) {
  return Object.entries(lhr.audits)
    .filter(([, a]) => {
      const isOpp = a.details?.type === 'opportunity';
      const failed = a.score != null && a.score < 0.9 &&
        a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'notApplicable';
      return isOpp || failed;
    })
    .map(([id, a]) => ({
      id,
      title: a.title,
      description: (a.description || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 220),
      saveMs: a.details?.type === 'opportunity' ? Math.round(a.details.overallSavingsMs || 0) : null,
      saveBytes: a.details?.overallSavingsBytes ? Math.round(a.details.overallSavingsBytes) : null,
      score: a.score === 0 || a.score == null ? 'FAIL' : Math.round(a.score * 100),
      category: auditCategory(lhr, id),
    }))
    .sort((a, b) => (b.saveMs || 0) - (a.saveMs || 0))
    .slice(0, 30);
}

// =============================================================================
//  ENGINE: Lighthouse (lab scoring)
// =============================================================================
async function runLighthouse(url, { device, throttling, port, cookieHeader }) {
  const settings = {
    onlyCategories: LH_CATEGORIES,
    formFactor: device === 'mobile' ? 'mobile' : 'desktop',
    screenEmulation: device === 'mobile'
      ? { mobile: true,  width: 412,  height: 823, deviceScaleFactor: 1.75, disabled: false }
      : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1,    disabled: false },
  };
  // Send the flow's session cookie with Lighthouse's own navigation, so it loads
  // logged-in/protected pages instead of being redirected to the login screen.
  if (cookieHeader) settings.extraHeaders = { Cookie: cookieHeader };
  if (!throttling) {
    settings.throttlingMethod = 'provided';
    settings.throttling = { rttMs: 0, throughputKbps: 0, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 };
  }
  const result = await lighthouse(
    url,
    { port, output: ['html', 'json'], logLevel: 'error', disableStorageReset: true },
    { extends: 'lighthouse:default', settings },
  );
  if (!result?.report) throw new Error('Lighthouse returned no report');
  // output:['html','json'] → report[0]=html, report[1]=json string.
  return { html: result.report[0], json: result.report[1], lhr: result.lhr };
}

// =============================================================================
//  ENGINE: Chrome DevTools (CDP) live capture via Playwright
//  Loads the page in a real browser and reads what it actually experienced:
//  FCP/LCP/CLS (PerformanceObserver), Navigation + Resource Timing, console
//  errors, and a screenshot. Complements Lighthouse's lab numbers.
// =============================================================================
// Measure whatever page is CURRENTLY loaded (no navigation). Used by the live
// capture mode so we snapshot the real, correctly-navigated, logged-in page.
// `prev` carries the resource-timing baseline from the previous step so we can
// report PER-STEP deltas (SauceDemo is an SPA — one page load, client-side nav,
// so cumulative timing would look identical on every page without this).
async function captureLivePage(page, thresholds, prev) {
  return measurePage(page, thresholds, prev);
}

async function captureCDP(page, url, thresholds) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200); // let late paints / layout shifts register
  return measurePage(page, thresholds);
}

// Shared measurement: reads PerformanceObserver/timing + a screenshot from the
// page as it currently is, and shapes the CDP result object. `prev` (optional)
// is { resCount, sinceStart } from the previous step so we can compute per-step
// deltas for SPAs (otherwise every client-nav page shows the same load metrics).
async function measurePage(page, thresholds, prev) {
  const consoleErrors = [];
  const onError = (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); };
  page.on('console', onError);
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.waitForTimeout(400); // settle

  const raw = await page.evaluate((prevState) => {
    const data = { fcp: null, lcp: null, cls: 0, ttfb: null, domContentLoaded: null, load: null, resources: [], transferBytes: 0, totalRequests: null };

    for (const e of performance.getEntriesByType('paint')) {
      if (e.name === 'first-contentful-paint') data.fcp = Math.round(e.startTime);
    }
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      data.ttfb = Math.round(nav.responseStart);
      data.domContentLoaded = Math.round(nav.domContentLoadedEventEnd);
      data.load = Math.round(nav.loadEventEnd || nav.duration);
    }
    const lcps = performance.getEntriesByType('largest-contentful-paint');
    if (lcps.length) data.lcp = Math.round(lcps[lcps.length - 1].startTime);

    let cls = 0;
    for (const e of performance.getEntriesByType('layout-shift')) {
      if (!e.hadRecentInput) cls += e.value;
    }
    data.cls = Math.round(cls * 1000) / 1000;

    const allRes = performance.getEntriesByType('resource');
    // Per-step view: only resources that loaded AFTER the previous step.
    const prevCount = (prevState && prevState.resCount) || 0;
    const stepRes = allRes.slice(prevCount);
    data.stepRequests = stepRes.length;                 // requests THIS step made
    data.stepDurationMs = stepRes.length                // how long this step's loads took
      ? Math.round(Math.max(...stepRes.map((r) => r.responseEnd)) - Math.min(...stepRes.map((r) => r.startTime)))
      : 0;
    data.stepTransferBytes = stepRes.reduce((s, r) => s + (r.transferSize || 0), 0);
    data.allResCount = allRes.length;                   // baseline for the next step

    const res = allRes.map((r) => ({
      name: r.name, type: r.initiatorType, duration: Math.round(r.duration),
      size: Math.round(r.transferSize || 0), start: Math.round(r.startTime),
    }));
    data.resources = res.sort((a, b) => b.size - a.size).slice(0, 30);
    data.transferBytes = res.reduce((sum, r) => sum + r.size, 0);
    data.totalRequests = res.length + 1; // +1 for the document itself
    return data;
  }, prev || {}).catch(() => ({}));

  let screenshot = null;
  try {
    screenshot = 'data:image/jpeg;base64,' + (await page.screenshot({ type: 'jpeg', quality: 55 })).toString('base64');
  } catch (_) { /* screenshots are best-effort */ }

  page.off('console', onError);

  const cdp = {
    finalUrl: page.url(),
    metrics: {
      fcp: raw.fcp ?? null, lcp: raw.lcp ?? null, cls: raw.cls ?? null,
      ttfb: raw.ttfb ?? null, domContentLoaded: raw.domContentLoaded ?? null, load: raw.load ?? null,
    },
    totalRequests: raw.totalRequests ?? null,
    transferKb: raw.transferBytes ? Math.round(raw.transferBytes / 1024) : null,
    // Per-step (real distinct values per page in an SPA journey).
    stepRequests: raw.stepRequests ?? null,
    stepDurationMs: raw.stepDurationMs ?? null,
    stepTransferKb: raw.stepTransferBytes ? Math.round(raw.stepTransferBytes / 1024) : 0,
    _resBaseline: raw.allResCount ?? 0,  // internal: baseline for next step
    consoleErrors: consoleErrors.length,
    consoleErrorSamples: consoleErrors.slice(0, 5),
    resources: raw.resources || [],
    screenshot,
  };

  // Colour bands for the CDP tiles.
  cdp.bands = {
    fcp: valueBand('fcp', cdp.metrics.fcp, thresholds),
    lcp: valueBand('lcp', cdp.metrics.lcp, thresholds),
    cls: valueBand('cls', cdp.metrics.cls, thresholds),
    ttfb: valueBand('ttfb', cdp.metrics.ttfb, thresholds),
    load: valueBand('pageLoad', cdp.metrics.load, thresholds),
    requests: valueBand('requests', cdp.totalRequests, thresholds),
    transferKb: valueBand('transferKb', cdp.transferKb, thresholds),
    consoleErrors: valueBand('consoleErrors', cdp.consoleErrors, thresholds),
  };
  return cdp;
}

// Launch a browser that already exists on the machine. Playwright's own chromium
// download is often blocked on corporate networks, so we fall back through the
// installed system channels (Chrome, then Edge), then bundled chromium.
// Available browser channels the user can pick in the Audit page.
const BROWSER_CHANNELS = {
  auto:     [{ channel: 'chrome', name: 'Google Chrome' }, { channel: 'msedge', name: 'Microsoft Edge' }, { name: 'Chromium (bundled)' }],
  chrome:   [{ channel: 'chrome', name: 'Google Chrome' }],
  msedge:   [{ channel: 'msedge', name: 'Microsoft Edge' }],
  chromium: [{ name: 'Chromium (bundled)' }],
};
// Records which browser the most recent launch actually used (shown in the UI).
let LAST_BROWSER = null;

// Launch a system browser. `prefer` is one of auto|chrome|msedge|chromium.
// `headed:true` opens a VISIBLE window so you can watch each page load live.
// Playwright's own chromium download is often blocked on corporate networks, so
// `auto` falls back through Chrome → Edge → bundled chromium.
async function launchBrowser(extraArgs = [], prefer = 'auto', headed = false) {
  let lastErr;
  const order = BROWSER_CHANNELS[prefer] || BROWSER_CHANNELS.auto;
  for (const opt of order) {
    try {
      const b = await chromium.launch({ headless: !headed, args: extraArgs, ...(opt.channel ? { channel: opt.channel } : {}) });
      LAST_BROWSER = opt.name + (headed ? ' (visible)' : '');
      return b;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('No usable browser. Install Chrome/Edge, or run: npx playwright install chromium');
}

// =============================================================================
//  RESULT SHAPING + PERSISTENCE
// =============================================================================
function saveReport(name, html) {
  const safe = String(name).replace(/[^a-z0-9]/gi, '_').slice(0, 50);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${safe}-${stamp}.html`;
  fs.writeFileSync(path.join(REPORTS_DIR, filename), html);
  return `/reports/${filename}`;
}

// Save an arbitrary file (json/md/etc.) into reports/ and return its URL.
function saveFile(baseName, ext, content) {
  const safe = String(baseName).replace(/[^a-z0-9]/gi, '_').slice(0, 50);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${safe}-${stamp}.${ext}`;
  fs.writeFileSync(path.join(REPORTS_DIR, filename), content);
  return `/reports/${filename}`;
}

// Render an HTML string to a PDF using the headless browser (best-effort).
async function savePdf(baseName, html) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newContext().then((c) => c.newPage());
    await page.setContent(html, { waitUntil: 'load' });
    const safe = String(baseName).replace(/[^a-z0-9]/gi, '_').slice(0, 50);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${safe}-${stamp}.pdf`;
    await page.pdf({ path: path.join(REPORTS_DIR, filename), format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
    return `/reports/${filename}`;
  } catch (_) {
    return null; // PDF is best-effort; never fail the run over it.
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const scoreColor = (s) => (s == null ? '#9aa0a6' : s >= 90 ? '#0c8a3e' : s >= 50 ? '#b8860b' : '#c5221f');

// A coloured donut/ring SVG for a 0-100 score.
function scoreRing(score, size = 92) {
  const c = scoreColor(score);
  const r = (size - 12) / 2, circ = 2 * Math.PI * r;
  const pct = score == null ? 0 : score / 100;
  const dash = (circ * pct).toFixed(1);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#eef0f3" stroke-width="9"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${dash} ${circ}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" text-anchor="middle" dy=".34em" font-size="${size * 0.3}" font-weight="800" fill="${c}">${score ?? '—'}</text>
  </svg>`;
}

// Build ONE self-contained, colourful dashboard report with EVERYTHING inline:
// hero score gauge, KPI cards, a summary table, and per-transaction cards with
// Lighthouse metric chips + CDP live tiles + a coloured network waterfall.
function buildJourneyReport(flowName, pages, device) {
  const ok = pages.filter((p) => !p.error && p.performanceScore != null);
  const avgScore = ok.length ? Math.round(ok.reduce((s, p) => s + p.performanceScore, 0) / ok.length) : null;
  const verdict = avgScore == null ? 'No data' : avgScore >= 90 ? 'Excellent — fast & healthy' : avgScore >= 50 ? 'Needs improvement' : 'Poor — significant issues';
  const totalReq = ok.reduce((s, p) => s + (p.cdp?.totalRequests || 0), 0);
  const totalKb = ok.reduce((s, p) => s + (p.cdp?.transferKb || 0), 0);
  const totalErr = ok.reduce((s, p) => s + (p.cdp?.consoleErrors || 0), 0);
  const num = (p, k) => (p.metrics || []).find((x) => x.key === k)?.numeric ?? null;
  const avgLcp = ok.length ? Math.round(ok.reduce((s, p) => s + (num(p, 'lcp') || 0), 0) / ok.length) : null;

  const kpi = (label, value, sub, color) =>
    `<div class="kpi"><div class="kpi-v" style="color:${color || '#1a1a2e'}">${value}</div><div class="kpi-l">${label}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}</div>`;

  // Summary table. For login-gated pages (no Lighthouse) we show a "CDP ✓ live"
  // badge + the per-step CDP numbers, so there's no misleading "—" / error look.
  const sumRows = pages.map((p, i) => {
    if (p.error) return `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td colspan="6" style="color:#c5221f">⚠ ${esc(p.error)}</td></tr>`;
    const scoreCell = p.lighthouseSkipped
      ? `<span class="badge live">CDP ✓</span>`
      : `<span class="badge" style="background:${scoreColor(p.performanceScore)}">${p.performanceScore ?? '—'}</span>`;
    if (p.lighthouseSkipped) {
      const c = p.cdp || {};
      return `<tr>
        <td class="muted">${i + 1}</td>
        <td><a href="#page-${i}"><b>${esc(p.name)}</b></a></td>
        <td>${scoreCell}</td>
        <td>${c.metrics?.fcp != null ? c.metrics.fcp + ' ms' : '—'}</td>
        <td>${c.stepRequests ?? '—'} req</td>
        <td>${c.stepDurationMs != null ? c.stepDurationMs + ' ms' : '—'}</td>
        <td>${c.consoleErrors ?? 0} err</td>
        <td>${c.stepTransferKb ?? '—'} KB</td></tr>`;
    }
    const m = (k) => (p.metrics || []).find((x) => x.key === k)?.value ?? '—';
    return `<tr>
      <td class="muted">${i + 1}</td>
      <td><a href="#page-${i}"><b>${esc(p.name)}</b></a></td>
      <td>${scoreCell}</td>
      <td>${m('lcp')}</td><td>${m('fcp')}</td><td>${m('cls')}</td><td>${m('tbt')}</td>
      <td>${p.cdp?.transferKb ?? '—'} KB</td></tr>`;
  }).join('\n');

  // Per-transaction detail cards.
  const detail = pages.map((p, i) => {
    if (p.error) return `<section id="page-${i}" class="tcard"><div class="tcard-head" style="background:linear-gradient(135deg,#c5221f,#7a1512)"><div class="th-name">${i + 1}. ${esc(p.name)}</div></div><div class="tcard-body"><p style="color:#c5221f">⚠ ${esc(p.error)}</p></div></section>`;
    const chip = (m) => `<div class="chip" style="border-color:${scoreColor(m.score)}"><span class="chip-k">${esc(m.label)}</span><span class="chip-v">${esc(m.value)}</span></div>`;
    const chips = (p.metrics || []).map(chip).join('');
    const opps = (p.opportunities || []).length
      ? `<div class="ops"><div class="ops-h">⚡ Top opportunities</div>${p.opportunities.slice(0, 6).map((o) => `<div class="op"><span class="op-t">${esc(o.title)}</span>${o.saveMs ? `<span class="op-s">save ~${o.saveMs} ms</span>` : ''}</div>`).join('')}</div>`
      : `<div class="ops ok-ops">✓ No failing audits — clean!</div>`;
    const cdp = p.cdp; let cdpBlock = '<p class="muted">No CDP data captured.</p>';
    if (cdp && cdp.metrics) {
      const tile = (label, val, b) => `<div class="tile" style="--bc:${b?.color || '#9aa0a6'}"><div class="tl">${label}</div><div class="tv">${val ?? 'n/a'}</div>${b?.text ? `<div class="tr" style="color:${b.color}">${b.text}</div>` : ''}</div>`;
      const ms = (v) => (v == null ? 'n/a' : v + ' ms');
      cdpBlock = `<div class="tiles">
        ${tile('FCP', ms(cdp.metrics.fcp), cdp.bands?.fcp)}${tile('LCP', ms(cdp.metrics.lcp), cdp.bands?.lcp)}
        ${tile('CLS', cdp.metrics.cls, cdp.bands?.cls)}${tile('TTFB', ms(cdp.metrics.ttfb), cdp.bands?.ttfb)}
        ${tile('Page Load', ms(cdp.metrics.load), cdp.bands?.load)}${tile('Requests', cdp.totalRequests, cdp.bands?.requests)}
        ${tile('Transferred', (cdp.transferKb ?? '—') + ' KB', cdp.bands?.transferKb)}${tile('Console errors', cdp.consoleErrors, cdp.bands?.consoleErrors)}</div>`;
      // Show the ACTUAL console error messages (so "2 errors" isn't a mystery).
      if (cdp.consoleErrors > 0 && (cdp.consoleErrorSamples || []).length) {
        cdpBlock += `<div class="cerr"><div class="cerr-h">⚠️ Console errors on this page (${cdp.consoleErrors})</div>${
          cdp.consoleErrorSamples.map((s) => `<div class="cerr-row">${esc(String(s).slice(0, 240))}</div>`).join('')}</div>`;
      }
      const res = (cdp.resources || []).slice(0, 12);
      if (res.length) {
        const max = Math.max(...res.map((r) => r.duration || 0), 1);
        cdpBlock += `<div class="wf-h">🌊 Network waterfall (top ${res.length} by size)</div><div class="wf">
          ${res.map((r) => `<div class="wf-row"><span class="wf-type">${esc(r.type || 'doc')}</span>
            <span class="wf-bar"><span style="width:${Math.max(3, ((r.duration || 0) / max) * 100)}%"></span></span>
            <span class="wf-meta">${r.duration} ms · ${r.size ? Math.round(r.size / 1024) + ' KB' : '—'}</span></div>`).join('')}</div>`;
      }
    }
    // Head: a score ring for Lighthouse pages, a "CDP live" pill for skipped ones.
    const headColor = p.lighthouseSkipped ? '#5b2be0' : scoreColor(p.performanceScore);
    const headBadge = p.lighthouseSkipped
      ? `<div class="cdp-pill">CDP&nbsp;✓<br><span>live</span></div>`
      : scoreRing(p.performanceScore, 70);
    // The captured screenshot of this exact page (proof the flow navigated here).
    const shotBlock = (p.cdp && p.cdp.screenshot)
      ? `<div class="sec-h">📸 Captured page</div><img class="page-shot" src="${p.cdp.screenshot}" alt="${esc(p.name)}">`
      : '';
    // Lighthouse section: chips for public pages, an honest note for skipped ones.
    const lhSection = p.lighthouseSkipped
      ? `<div class="sec-h">🔦 Lighthouse</div><div class="ops ok-ops" style="background:#eef0ff;color:#5b2be0">ℹ️ Login-gated page — measured live via Chrome DevTools below (Lighthouse can't cold-load a logged-in page).</div>`
      : `<div class="sec-h">🔦 Lighthouse metrics</div><div class="chips">${chips}</div>${opps}`;
    // Per-step tiles (real distinct values per page in the journey).
    const stepBlock = (p.cdp && p.cdp.stepRequests != null)
      ? `<div class="tiles" style="margin-top:10px">
          <div class="tile" style="--bc:#5b2be0"><div class="tl">This step — requests</div><div class="tv">${p.cdp.stepRequests}</div></div>
          <div class="tile" style="--bc:#5b2be0"><div class="tl">This step — time</div><div class="tv">${p.cdp.stepDurationMs ?? '—'} ms</div></div>
          <div class="tile" style="--bc:#5b2be0"><div class="tl">This step — transferred</div><div class="tv">${p.cdp.stepTransferKb ?? 0} KB</div></div>
          <div class="tile" style="--bc:#5b2be0"><div class="tl">Console errors</div><div class="tv">${p.cdp.consoleErrors ?? 0}</div></div>
        </div>` : '';
    return `<section id="page-${i}" class="tcard">
      <div class="tcard-head" style="background:linear-gradient(135deg,${headColor},${headColor}cc)">
        <div>${headBadge}</div>
        <div class="th-info"><div class="th-name">${i + 1}. ${esc(p.name)}</div><div class="th-url">${esc(p.finalUrl || p.url)}</div></div>
      </div>
      <div class="tcard-body">
        ${shotBlock}
        ${lhSection}
        <div class="sec-h">🛠️ Chrome DevTools (live)</div>
        ${stepBlock}
        ${cdpBlock}
        ${p.reportUrl ? `<p style="margin-top:12px"><a href="${p.reportUrl}" target="_blank">Open full Lighthouse report ↗</a></p>` : ''}
      </div></section>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Journey report — ${esc(flowName)}</title>
  <style>
    *{box-sizing:border-box}
    body{font:14px/1.55 'Segoe UI',-apple-system,Roboto,sans-serif;margin:0;background:#eef1f6;color:#1a1a2e}
    .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 56px}
    a{color:#5b5bff;text-decoration:none} a:hover{text-decoration:underline}
    .muted{color:#8a90a2}
    /* HERO */
    .hero{background:linear-gradient(135deg,#5b2be0 0%,#8b2fd6 50%,#c5267f 100%);color:#fff;border-radius:20px;padding:30px 34px;
      display:flex;align-items:center;gap:28px;box-shadow:0 16px 40px rgba(91,43,224,.32);margin-bottom:18px;flex-wrap:wrap}
    .hero-gauge svg circle:first-child{stroke:rgba(255,255,255,.25)}
    .hero h1{margin:0 0 6px;font-size:26px;font-weight:800;letter-spacing:-.3px}
    .hero .meta{opacity:.9;font-size:13.5px}
    .hero .verdict{display:inline-block;margin-top:10px;background:rgba(255,255,255,.18);padding:5px 14px;border-radius:20px;font-weight:600;font-size:13px;backdrop-filter:blur(4px)}
    /* KPI row */
    .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:22px}
    .kpi{background:#fff;border-radius:16px;padding:18px;text-align:center;box-shadow:0 4px 14px rgba(20,20,60,.06)}
    .kpi-v{font-size:26px;font-weight:800;line-height:1} .kpi-l{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8a90a2;margin-top:6px} .kpi-s{font-size:11px;color:#b0b4c2;margin-top:2px}
    /* card */
    .panel{background:#fff;border-radius:18px;padding:22px 26px;margin-bottom:20px;box-shadow:0 4px 14px rgba(20,20,60,.06)}
    .panel h2{margin:0 0 14px;font-size:17px}
    table{width:100%;border-collapse:collapse} th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #f0f1f5}
    th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8a90a2} tr:hover td{background:#fafbff}
    .badge{display:inline-block;min-width:34px;text-align:center;padding:3px 11px;border-radius:20px;color:#fff;font-weight:700;font-size:13px}
    .badge.live{background:#5b2be0}
    .page-shot{width:100%;border-radius:12px;border:1px solid #e7e9f0;margin:4px 0 8px;box-shadow:0 2px 10px rgba(20,20,60,.08)}
    .cerr{margin-top:12px;background:#fff5f5;border:1px solid #ffd7d7;border-radius:10px;padding:12px 14px}
    .cerr-h{font-weight:700;font-size:13px;color:#c5221f;margin-bottom:6px}
    .cerr-row{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#7a1512;padding:3px 0;border-bottom:1px dashed #ffe0e0;word-break:break-all}
    .cerr-row:last-child{border:0}
    .cdp-pill{width:70px;height:70px;border-radius:50%;background:rgba(255,255,255,.18);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;line-height:1.1}
    .cdp-pill span{font-size:11px;font-weight:600;opacity:.9}
    /* transaction card */
    .tcard{background:#fff;border-radius:18px;overflow:hidden;margin-bottom:20px;box-shadow:0 6px 20px rgba(20,20,60,.08)}
    .tcard-head{display:flex;align-items:center;gap:18px;padding:18px 24px;color:#fff}
    .tcard-head svg text{fill:#fff} .tcard-head svg circle:first-child{stroke:rgba(255,255,255,.3)} .tcard-head svg circle:last-child{stroke:#fff}
    .th-name{font-size:18px;font-weight:700} .th-url{font-size:12.5px;opacity:.9;word-break:break-all}
    .tcard-body{padding:20px 24px}
    .sec-h{font-size:13px;font-weight:700;color:#5b2be0;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 10px}
    .sec-h:first-child{margin-top:0}
    .chips{display:flex;flex-wrap:wrap;gap:10px}
    .chip{border:2px solid #ccc;border-radius:12px;padding:8px 14px;min-width:92px} .chip-k{display:block;font-size:11px;color:#8a90a2;text-transform:uppercase} .chip-v{display:block;font-size:17px;font-weight:700}
    .ops{margin:14px 0;background:#fff8ec;border-radius:12px;padding:12px 16px} .ops-h{font-weight:700;font-size:13px;margin-bottom:6px;color:#b8860b}
    .op{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed #f0e6cf;font-size:13px} .op:last-child{border:0} .op-s{color:#b8860b;font-weight:600;white-space:nowrap;margin-left:10px}
    .ok-ops{background:#eaf7ee;color:#0c8a3e;font-weight:600}
    .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
    .tile{background:#f8f9fd;border-radius:12px;padding:12px 14px;border-left:5px solid var(--bc)} .tl{font-size:11px;color:#8a90a2;text-transform:uppercase} .tv{font-size:21px;font-weight:800;margin:3px 0} .tr{font-size:11px;font-weight:600}
    .wf-h{font-size:13px;font-weight:700;margin:18px 0 10px}
    .wf-row{display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px}
    .wf-type{width:64px;color:#8a90a2;text-transform:uppercase;font-size:10.5px}
    .wf-bar{flex:1;background:#eef1f6;border-radius:6px;height:14px;overflow:hidden} .wf-bar span{display:block;height:100%;background:linear-gradient(90deg,#5b2be0,#c5267f);border-radius:6px}
    .wf-meta{width:140px;text-align:right;color:#8a90a2}
    .foot{text-align:center;color:#b0b4c2;font-size:12px;margin-top:24px}
    @media print{body{background:#fff} .hero,.tcard,.kpi,.panel{box-shadow:none;border:1px solid #eef0f3} .tcard{break-inside:avoid}}
    @media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}.tiles{grid-template-columns:repeat(2,1fr)}}
  </style></head><body><div class="wrap">
    <div class="hero">
      <div class="hero-gauge">${scoreRing(avgScore, 116)}</div>
      <div><h1>🧭 ${esc(flowName)}</h1>
        <div class="meta">${pages.length} transactions · ${esc(device)} · ${new Date().toLocaleString()}</div>
        <div class="verdict">${verdict}</div></div>
    </div>
    <div class="kpis">
      ${kpi('Avg score', avgScore ?? '—', verdict.split(' —')[0], scoreColor(avgScore))}
      ${kpi('Transactions', pages.length, ok.length + ' passed')}
      ${kpi('Avg LCP', avgLcp != null ? avgLcp + ' ms' : '—', 'load speed')}
      ${kpi('Requests', totalReq || '—', totalKb + ' KB total')}
      ${kpi('Console errors', totalErr, totalErr ? 'needs attention' : 'none', totalErr ? '#c5221f' : '#0c8a3e')}
    </div>
    <div class="panel"><h2>📋 Summary — all transactions</h2>
      <table><thead><tr><th>#</th><th>Transaction</th><th>Score</th><th>LCP</th><th>FCP</th><th>CLS</th><th>TBT</th><th>Transferred</th></tr></thead><tbody>${sumRows}</tbody></table>
    </div>
    ${detail}
    <div class="foot">Generated by <b>PulseLab</b> · 🔦 Lighthouse (lab) + 🛠️ Chrome DevTools/CDP (live) · self-contained, all transactions inline.</div>
  </div></body></html>`;
}

// Markdown version of the overall journey report.
function buildJourneyMarkdown(flowName, pages, device) {
  const ok = pages.filter((p) => !p.error && p.performanceScore != null);
  const avg = ok.length ? Math.round(ok.reduce((s, p) => s + p.performanceScore, 0) / ok.length) : '—';
  const L = [`# 🧭 Journey report — ${flowName}`, '', `${pages.length} transactions · device: ${device} · ${new Date().toLocaleString()}`, '', `**Average performance score: ${avg}**`, '', '## Summary', '', '| # | Transaction | Score | LCP | FCP | CLS | TBT | Transferred |', '|---|---|---|---|---|---|---|---|'];
  pages.forEach((p, i) => {
    if (p.error) { L.push(`| ${i + 1} | ${p.name} | ERROR | | | | | |`); return; }
    const m = (k) => (p.metrics || []).find((x) => x.key === k)?.value ?? '—';
    L.push(`| ${i + 1} | ${p.name} | ${p.performanceScore ?? '—'} | ${m('lcp')} | ${m('fcp')} | ${m('cls')} | ${m('tbt')} | ${p.cdp?.transferKb ?? '—'} KB |`);
  });
  pages.forEach((p, i) => {
    L.push('', `## ${i + 1}. ${p.name}`, `\`${p.url}\``, '');
    if (p.error) { L.push(`Error: ${p.error}`); return; }
    L.push('**Lighthouse (lab):** ' + (p.metrics || []).map((m) => `${m.label} ${m.value} (${m.score ?? '—'})`).join(' · '));
    if (p.cdp?.metrics) {
      const c = p.cdp;
      L.push('', `**CDP (live):** FCP ${c.metrics.fcp ?? 'n/a'}ms · LCP ${c.metrics.lcp ?? 'n/a'}ms · CLS ${c.metrics.cls ?? 'n/a'} · TTFB ${c.metrics.ttfb ?? 'n/a'}ms · Load ${c.metrics.load ?? 'n/a'}ms · ${c.totalRequests ?? '—'} requests · ${c.transferKb ?? '—'} KB · ${c.consoleErrors} console errors`);
    }
    if ((p.opportunities || []).length) L.push('', '**Opportunities:** ' + p.opportunities.map((o) => `${o.title} (~${o.saveMs}ms)`).join('; '));
  });
  return L.join('\n');
}

function summarisePage({ name, url, lhr, thresholds, reportUrl, jsonUrl, cdp, lighthouseSkipped = false }) {
  // If Lighthouse got redirected to login (protected page it can't cold-load),
  // its numbers describe the login page, not the real one — so we drop them and
  // rely on the CDP (live, logged-in) capture, marking Lighthouse N/A honestly.
  if (lighthouseSkipped) {
    return {
      name, url,
      finalUrl: cdp?.finalUrl || url,
      performanceScore: null,
      verdict: 'Lighthouse n/a — page needs login (measured live via CDP instead)',
      lighthouseSkipped: true,
      categories: [],
      metrics: [],
      opportunities: [],
      insights: ['This page requires a logged-in session, which Lighthouse cannot cold-load. The live CDP capture below reflects the real page.'],
      cdp: cdp || null,
      reportUrl: null,
      jsonUrl: null,
    };
  }
  const metrics = extractMetrics(lhr);
  const categories = extractCategories(lhr);
  const perf = categories.find((c) => c.key === 'performance');
  return {
    name,
    url,
    finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || url,
    performanceScore: perf ? perf.score : null,
    verdict: verdict(perf ? perf.score : null),
    categories,
    metrics,
    opportunities: extractOpportunities(lhr),
    insights: buildInsights(metrics, lhr),
    cdp: cdp || null,
    reportUrl,
    jsonUrl: jsonUrl || null, // raw Lighthouse JSON, for "Download JSON"
  };
}

function metricNumeric(page, key) {
  return page.metrics.find((m) => m.key === key)?.numeric ?? null;
}

function recordRun(run) {
  // Stamp a stable unique id so the UI can delete / compare a specific run.
  run.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const history = readJson(HISTORY_FILE, []);
  history.unshift(run);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 200), null, 2));
}

// Map a /reports/... or /downloads/... URL back to a file on disk (for cleanup).
function urlToDiskPath(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^\/(reports|downloads)\/(.+)$/);
  if (!m) return null;
  const base = m[1] === 'reports' ? REPORTS_DIR : DATA_DIR;
  const p = path.join(base, path.basename(m[2])); // basename guards against path traversal
  return p.startsWith(base) ? p : null;
}

// Collect every report/download URL a run produced, so deleting a run also
// removes its files from disk (no orphaned reports).
function runFileUrls(run) {
  const urls = new Set();
  if (run.reportUrl) urls.add(run.reportUrl);
  for (const f of Object.values(run.formats || {})) if (f) urls.add(f);
  for (const r of run.reports || []) if (r.url) urls.add(r.url);
  return [...urls];
}

// Discover saved journeys from the flows/ folder (.js / .json).
function listFlows() {
  if (!fs.existsSync(FLOWS_DIR)) return [];
  return fs.readdirSync(FLOWS_DIR)
    .filter((f) => ['.js', '.json'].includes(path.extname(f).toLowerCase()))
    .map((f) => {
      const ext = path.extname(f).toLowerCase();
      const flow = { name: path.basename(f, ext), file: f, type: ext.slice(1).toUpperCase(), steps: null, startUrl: null };
      if (ext === '.json') {
        const j = readJson(path.join(FLOWS_DIR, f), {});
        const steps = Array.isArray(j.steps) ? j.steps : Array.isArray(j) ? j : [];
        flow.steps = steps.length || null;
        flow.startUrl = j.startUrl || j.start || steps[0]?.url || null;
      }
      return flow;
    });
}

// Load a JS flow module (without running it) to inspect its exports.
async function loadFlowModule(flowPath) {
  return import(pathToFileURL(flowPath).href + '?t=' + Date.now());
}

// Resolve a flow file into the list of pages to audit.
async function resolveAuditPoints(flowPath, page, context) {
  const ext = path.extname(flowPath).toLowerCase();
  if (ext === '.js') {
    const mod = await loadFlowModule(flowPath);
    if (typeof mod.default === 'function') await mod.default({ page, context, log: () => {} });
    return {
      auditPoints: mod.auditPoints || [{ name: 'start', url: page.url() }],
      // Optional: a login-only function the audit can re-run to re-establish the
      // session before scoring each protected page (so they don't redirect to login).
      setup: typeof mod.setup === 'function' ? mod.setup : null,
    };
  }
  // .json: { startUrl, steps:[{name,url}] }  or  [{url}]
  const j = readJson(flowPath, {});
  const steps = Array.isArray(j.steps) ? j.steps : Array.isArray(j) ? j : [];
  const points = steps.filter((s) => s?.url).map((s, i) => ({ name: s.name || `Page ${i + 1}`, url: s.url }));
  if (j.startUrl) points.unshift({ name: 'Start', url: j.startUrl });
  return { auditPoints: points.length ? points : [{ name: 'start', url: j.startUrl || j.start }], setup: null };
}

function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fallback;
}

// =============================================================================
//  HTTP ROUTES
// =============================================================================
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.get('/api/state', (req, res) => {
  res.json({
    ready: !auditRunning,
    running: auditRunning,
    thresholds: readThresholds(),
    flows: listFlows(),
    history: readJson(HISTORY_FILE, []).slice(0, 50),
  });
});

app.get('/api/thresholds', (req, res) => res.json({ thresholds: readThresholds() }));

app.post('/api/thresholds', (req, res) => {
  const incoming = req.body?.thresholds;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Missing thresholds object' });
  const current = readThresholds();
  for (const key of Object.keys(current)) {
    if (incoming[key]?.good !== undefined) current[key].good = Number(incoming[key].good);
    if (incoming[key]?.ni !== undefined) current[key].ni = Number(incoming[key].ni);
  }
  fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(current, null, 2));
  res.json({ message: 'Thresholds saved', thresholds: current });
});

app.get('/api/history', (req, res) => res.json({ history: readJson(HISTORY_FILE, []) }));

// Delete one history entry (by id) AND its report files on disk.
app.delete('/api/history/:id', (req, res) => {
  const history = readJson(HISTORY_FILE, []);
  const idx = history.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: 'Run not found' });
  const [run] = history.splice(idx, 1);
  let removed = 0;
  for (const url of runFileUrls(run)) {
    const p = urlToDiskPath(url);
    if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); removed++; } catch (_) {} }
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  res.json({ message: 'Run deleted', filesRemoved: removed });
});

// Compare 2+ runs side by side — returns the key metrics for each requested id.
app.get('/api/compare', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ message: 'Pick at least 2 runs to compare' });
  const history = readJson(HISTORY_FILE, []);
  const runs = ids.map((id) => history.find((r) => r.id === id)).filter(Boolean).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, date: r.date,
    score: r.score, pages: r.pages, avgLcp: r.avgLcp, avgCls: r.avgCls,
    reportUrl: r.reportUrl,
  }));
  if (runs.length < 2) return res.status(404).json({ message: 'Some runs were not found' });
  res.json({ runs });
});

// Live progress of the running flow (the Audit page polls this to stream the
// browser screenshot + which step is running).
app.get('/api/live', (req, res) => res.json(LIVE));

// --- Save a new flow (Paste/Upload or Import JSON from the Add-flow menu) ----
app.post('/api/flow', (req, res) => {
  let { name, content, type } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'Flow content is empty' });
  const ext = (type === 'json' || type === 'js') ? type : (String(content).trim().startsWith('{') || String(content).trim().startsWith('[') ? 'json' : 'js');
  const safe = String(name || 'flow').replace(/[^a-z0-9._-]/gi, '-').replace(/\.(js|json)$/i, '').slice(0, 60) || 'flow';
  if (ext === 'json') { try { JSON.parse(content); } catch (e) { return res.status(400).json({ error: 'Invalid JSON: ' + e.message }); } }
  const file = `${safe}.${ext}`;
  fs.writeFileSync(path.join(FLOWS_DIR, file), content);
  res.json({ message: 'Flow saved', file, flows: listFlows() });
});

// --- View a flow's source ---------------------------------------------------
app.get('/api/flow/:file', (req, res) => {
  const fp = path.join(FLOWS_DIR, path.basename(req.params.file));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Flow not found' });
  res.json({ file: path.basename(fp), content: fs.readFileSync(fp, 'utf8') });
});

// --- RECORD a flow: open a VISIBLE browser, let the user click through the
// journey, capture every navigation, then write a runnable flow file. ---------
let recordingState = null;
app.post('/api/record/start', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing start URL' });
  if (recordingState) return res.status(409).json({ error: 'A recording is already in progress.' });
  try {
    const browser = await launchBrowser([], 'auto', true); // headed = visible window
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    const visited = [];
    // Record each committed navigation as a journey step.
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) {
        const u = f.url();
        if (u && u !== 'about:blank' && (!visited.length || visited[visited.length - 1].url !== u)) {
          visited.push({ name: `step-${visited.length + 1}`, url: u });
        }
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    recordingState = { browser, context, page, visited, name: name || 'recorded-flow', startedAt: Date.now() };
    res.json({ message: 'Recording started — click through the journey in the opened browser, then Stop.', startUrl: url });
  } catch (err) { res.status(500).json({ error: 'Could not open browser: ' + err.message }); }
});

app.get('/api/record/status', (req, res) => {
  if (!recordingState) return res.json({ recording: false });
  res.json({ recording: true, steps: recordingState.visited.length, current: recordingState.page.url(), name: recordingState.name });
});

app.post('/api/record/stop', async (req, res) => {
  if (!recordingState) return res.status(400).json({ error: 'No recording in progress.' });
  const { browser, visited, name } = recordingState;
  // De-dup consecutive URLs into auditPoints (JSON flow — simplest, replayable).
  const steps = visited.filter((s, i) => i === 0 || s.url !== visited[i - 1].url);
  try { await browser.close(); } catch (_) {}
  recordingState = null;
  if (!steps.length) return res.status(400).json({ error: 'No pages were navigated — nothing to save.' });
  const safe = String(name).replace(/[^a-z0-9._-]/gi, '-').replace(/\.json$/i, '').slice(0, 60) || 'recorded-flow';
  const file = `${safe}.json`;
  const flow = { name, startUrl: steps[0].url, steps, recordedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(FLOWS_DIR, file), JSON.stringify(flow, null, 2));
  res.json({ message: 'Recording saved', file, steps: steps.length, flows: listFlows() });
});

// --- Preview a flow's traversal steps (auditPoints) WITHOUT running it -------
app.get('/api/flow-preview/:file', async (req, res) => {
  const fp = path.join(FLOWS_DIR, path.basename(req.params.file));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Flow not found' });
  const ext = path.extname(fp).toLowerCase();
  try {
    if (ext === '.js') {
      // Import the module statically (don't run the flow) and read auditPoints.
      const mod = await import(pathToFileURL(fp).href + '?t=' + Date.now());
      return res.json({ file: path.basename(fp), steps: mod.auditPoints || [], hasSetup: typeof mod.setup === 'function' });
    }
    const j = readJson(fp, {});
    const steps = Array.isArray(j.steps) ? j.steps : Array.isArray(j) ? j : [];
    const points = steps.filter((s) => s?.url).map((s, i) => ({ name: s.name || `Page ${i + 1}`, url: s.url }));
    if (j.startUrl) points.unshift({ name: 'Start', url: j.startUrl });
    res.json({ file: path.basename(fp), steps: points, hasSetup: false });
  } catch (e) { res.json({ file: path.basename(fp), steps: [], error: e.message }); }
});

// --- Delete a flow ----------------------------------------------------------
app.delete('/api/flow/:file', (req, res) => {
  const fp = path.join(FLOWS_DIR, path.basename(req.params.file));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Flow not found' });
  fs.unlinkSync(fp);
  res.json({ message: 'Flow deleted', flows: listFlows() });
});

// --- Audit one URL: Lighthouse (lab) + CDP (live) ---------------------------
app.post('/api/audit', async (req, res) => {
  const { url, device = 'desktop', throttling = false, browser: prefer = 'auto', headed = false } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (auditRunning) return res.status(409).json({ error: 'Another audit is already running. Please wait.' });
  auditRunning = true;

  let chrome, browser;
  try {
    // Lighthouse pass.
    chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'] });
    const { html, json, lhr } = await runLighthouse(url, { device, throttling, port: chrome.port });
    const reportUrl = saveReport(url, html);
    const jsonUrl = json ? saveFile(`lhr-${url}`, 'json', json) : null;
    // chrome.kill() can throw EPERM on Windows during temp cleanup; the audit
    // data is already captured, so a teardown error must not lose it.
    try { await chrome.kill(); } catch (_) {}
    chrome = null;

    const thresholds = readThresholds();

    // CDP pass (best-effort; needs a system browser).
    let cdp = null;
    try {
      browser = await launchBrowser([], prefer, headed);
      const ctx = await browser.newContext({ viewport: { width: 1350, height: 940 } });
      cdp = await captureCDP(await ctx.newPage(), url, thresholds);
      await browser.close();
      browser = null;
    } catch (_) { if (browser) { await browser.close().catch(() => {}); browser = null; } }

    const page = summarisePage({ name: 'Entry', url, lhr, thresholds, reportUrl, jsonUrl, cdp });
    auditRunning = false;

    // Build the same downloadable report set as flows (so the History row's
    // Actions show HTML / PDF / MD / JSON for single-URL audits too).
    const safeName = (url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').slice(0, 40)) || 'audit';
    const overallHtml = buildJourneyReport(url, [page], device);
    const htmlUrl = saveReport(`audit-${safeName}`, overallHtml);
    const mdUrl = saveFile(`audit-${safeName}`, 'md', buildJourneyMarkdown(url, [page], device));
    const jsnUrl = saveFile(`audit-${safeName}`, 'json', JSON.stringify({ url, device, date: new Date().toISOString(), pages: [page] }, null, 2));
    const pdfUrl = await savePdf(`audit-${safeName}`, overallHtml);

    const run = {
      kind: 'audit', name: url, date: new Date().toISOString(), pages: 1,
      score: page.performanceScore, avgLcp: metricNumeric(page, 'lcp'), avgCls: metricNumeric(page, 'cls'),
      reportUrl: htmlUrl,
      formats: { html: htmlUrl, pdf: pdfUrl, md: mdUrl, json: jsnUrl },
    };
    recordRun(run);
    res.json({ message: 'Audit complete', mode: 'single', run, pages: [page], thresholds, browserUsed: LAST_BROWSER });
  } catch (err) {
    if (chrome) await chrome.kill().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    auditRunning = false;
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Audit a saved flow: Playwright traversal + per-page Lighthouse + CDP ----
app.post('/api/traverse', async (req, res) => {
  const { flow: flowFile, device = 'desktop', browser: prefer = 'auto', headed = false } = req.body || {};
  if (!flowFile) return res.status(400).json({ error: 'Missing flow' });
  if (auditRunning) return res.status(409).json({ error: 'Another audit is already running. Please wait.' });

  const flowPath = path.join(FLOWS_DIR, path.basename(flowFile));
  if (!fs.existsSync(flowPath)) return res.status(404).json({ error: `Flow not found: ${flowFile}` });
  auditRunning = true;
  liveReset(path.basename(flowFile));

  // One browser with a debug port so Lighthouse can attach to the same Chrome
  // that holds the logged-in Playwright session (authenticated pages get scored).
  let browser, chrome;
  const pages = [];
  try {
    const thresholds = readThresholds();
    const mod = path.extname(flowPath).toLowerCase() === '.js' ? await loadFlowModule(flowPath) : null;

    if (mod && typeof mod.captureFlow === 'function') {
      // LIVE MODE: launch Chrome via chrome-launcher (Lighthouse's own browser),
      // connect Playwright to that SAME chrome over CDP, and walk the journey by
      // CLICKING. Because Lighthouse and the journey share one browser+session,
      // Lighthouse can score EVERY page (incl. logged-in ones) with no redirect.
      chrome = await chromeLauncher.launch({ chromeFlags: [headed ? '' : '--headless=new', '--no-sandbox', '--disable-gpu'].filter(Boolean) });
      LAST_BROWSER = 'Google Chrome' + (headed ? ' (visible)' : '');
      const port = chrome.port;
      browser = await chromium.connectOverCDP(`http://localhost:${port}`);
      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();
      await page.setViewportSize({ width: 1350, height: 940 }).catch(() => {});

      // PASS 1 — walk the journey, capturing CDP + screenshot at each page WITHOUT
      // running Lighthouse yet (so the flow tab is never disturbed mid-journey).
      let resBaseline = 0;
      const captured = [];
      const capture = async (name, opts = {}) => {
        try {
          const cdp = await captureLivePage(page, thresholds, { resCount: resBaseline });
          resBaseline = cdp._resBaseline || resBaseline;
          liveStep(name, page.url(), cdp.screenshot);
          captured.push({ name, url: page.url(), cdp });
        } catch (err) {
          captured.push({ name, url: page.url(), error: err.message });
        }
      };
      await mod.captureFlow({ page, context, capture, log: () => {} });

      // PASS 2 — the journey is done and the browser is still logged in. Run
      // Lighthouse on each captured URL in a SEPARATE tab (same browser+session),
      // so protected pages score for real and the journey tab is untouched.
      const lhTab = await context.newPage();
      for (const c of captured) {
        if (c.error) { pages.push({ name: c.name, url: c.url, error: c.error, metrics: [], categories: [], opportunities: [], insights: [] }); continue; }
        // Safety net: a blank/invalid captured URL can never score — fall back to
        // the CDP capture instead of feeding about:blank into Lighthouse (→ 0).
        if (!c.url || c.url === 'about:blank' || !/^https?:/i.test(c.url)) {
          pages.push(summarisePage({ name: c.name, url: c.url, lhr: { categories: {}, audits: {} }, thresholds, cdp: c.cdp, lighthouseSkipped: true }));
          continue;
        }
        let lhr = null, html = null, json = null;
        try {
          await lhTab.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          const out = await runLighthouse(c.url, { device, throttling: false, port });
          lhr = out.lhr; html = out.html; json = out.json;
        } catch (e) { if (e.lhr) lhr = e.lhr; }
        const lhFinal = (lhr?.finalDisplayedUrl || lhr?.finalUrl || '').replace(/\/+$/, '');
        const bounced = !lhr || (lhFinal && lhFinal !== c.url.replace(/\/+$/, '') && /\/(\?|$)/.test(lhr?.finalDisplayedUrl || ''));
        if (bounced) {
          pages.push(summarisePage({ name: c.name, url: c.url, lhr: { categories: {}, audits: {} }, thresholds, cdp: c.cdp, lighthouseSkipped: true }));
        } else {
          const reportUrl = html ? saveReport(c.name, html) : null;
          const jsonUrl = json ? saveFile(`lhr-${c.name}`, 'json', json) : null;
          pages.push(summarisePage({ name: c.name, url: c.url, lhr, thresholds, reportUrl, jsonUrl, cdp: c.cdp }));
        }
      }
      await lhTab.close().catch(() => {});
    } else {
      const port = 9222 + Math.floor(Math.random() * 200);
      browser = await launchBrowser([`--remote-debugging-port=${port}`], prefer, headed);
      const context = await browser.newContext({ viewport: { width: 1350, height: 940 } });
      const page = await context.newPage();
      // CLASSIC MODE: run the flow, then cold-load each auditPoint URL.
      const { auditPoints, setup } = await resolveAuditPoints(flowPath, page, context);
      if (!auditPoints.length || !auditPoints[0].url) throw new Error('Flow has no auditable URLs');
      for (const ap of auditPoints) {
        try {
          if (setup) { try { await setup({ page, context }); } catch (_) {} }
          const cdp = await captureCDP(page, ap.url, thresholds);
          const cookieHeader = (await context.cookies())
            .filter((c) => ap.url.includes(c.domain.replace(/^\./, '')))
            .map((c) => `${c.name}=${c.value}`).join('; ');
          const { html, json, lhr } = await runLighthouse(ap.url, { device, throttling: false, port, cookieHeader });
          const lhFinal = lhr.finalDisplayedUrl || lhr.finalUrl || '';
          const redirected = !!ap.url && lhFinal.replace(/\/+$/, '') !== ap.url.replace(/\/+$/, '')
            && /\/(\?|$)/.test(lhFinal) && ap.url !== lhFinal && ap.name.toLowerCase() !== 'login';
          if (redirected) {
            pages.push(summarisePage({ name: ap.name, url: ap.url, lhr, thresholds, reportUrl: null, jsonUrl: null, cdp, lighthouseSkipped: true }));
          } else {
            const reportUrl = saveReport(ap.name, html);
            const jsonUrl = json ? saveFile(`lhr-${ap.name}`, 'json', json) : null;
            pages.push(summarisePage({ name: ap.name, url: ap.url, lhr, thresholds, reportUrl, jsonUrl, cdp }));
          }
        } catch (err) {
          pages.push({ name: ap.name, url: ap.url, error: err.message, metrics: [], categories: [], opportunities: [], insights: [] });
        }
      }
    }
    await browser.close().catch(() => {});
    browser = null;
    if (chrome) { try { await chrome.kill(); } catch (_) {} chrome = null; }
    auditRunning = false;
    LIVE.running = false;

    const ok = pages.filter((p) => !p.error);
    const avg = (sel) => (ok.length ? Math.round(ok.reduce((sum, p) => sum + (sel(p) || 0), 0) / ok.length) : null);
    // One combined "overall" report for the whole journey, in every format.
    // It embeds each transaction's Lighthouse + CDP details inline.
    const flowBase = path.basename(flowFile, '.js');
    const overallHtml = buildJourneyReport(path.basename(flowFile), pages, device);
    const journeyUrl = saveReport(`journey-${flowBase}`, overallHtml);
    const journeyMd = saveFile(`journey-${flowBase}`, 'md', buildJourneyMarkdown(path.basename(flowFile), pages, device));
    const journeyJson = saveFile(`journey-${flowBase}`, 'json', JSON.stringify({
      flow: path.basename(flowFile), device, date: new Date().toISOString(), pages,
    }, null, 2));
    const journeyPdf = await savePdf(`journey-${flowBase}`, overallHtml); // best-effort
    const perPage = ok.filter((p) => p.reportUrl).map((p) => ({ name: p.name, url: p.reportUrl }));
    const reports = [{ name: '🧭 Overall journey', url: journeyUrl }, ...perPage];
    const run = {
      kind: 'flow', name: path.basename(flowFile), date: new Date().toISOString(), pages: pages.length,
      score: avg((p) => p.performanceScore),
      avgLcp: avg((p) => metricNumeric(p, 'lcp')),
      avgCls: ok.length ? ok.reduce((s, p) => s + (metricNumeric(p, 'cls') || 0), 0) / ok.length : null,
      reportUrl: journeyUrl, // the overall report (keeps single-link UI working)
      reports, // overall + all per-page reports
      // Multi-format downloads of the overall report (PDF/MD/JSON) for ACTIONS.
      formats: { html: journeyUrl, pdf: journeyPdf, md: journeyMd, json: journeyJson },
    };
    recordRun(run);
    res.json({ message: 'Traversal complete', mode: 'flow', run, pages, thresholds, browserUsed: LAST_BROWSER });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    if (chrome) { try { await chrome.kill(); } catch (_) {} }
    auditRunning = false;
    LIVE.running = false;
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Saved HTML reports (index + static files).
app.get('/reports', (req, res) => {
  const files = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.html')).sort().reverse()
    : [];
  const items = files.map((f) => `<li><a href="/reports/${f}" target="_blank">${f}</a></li>`).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Reports</title><h1>Saved Lighthouse reports</h1><ul>${items}</ul><p><a href="/">Back to PulseLab</a></p>`);
});
app.use('/reports', express.static(REPORTS_DIR));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`PulseLab listening: http://127.0.0.1:${PORT}`));
