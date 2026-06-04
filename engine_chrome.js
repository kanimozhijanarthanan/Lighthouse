/*
 * engine.js — Chrome DevTools (CDP) capture core for the MCP server.
 *
 * Loads a page in a real browser (system Chrome/Edge via Playwright) and reads
 * what the browser actually experienced: FCP / LCP / CLS via PerformanceObserver,
 * Navigation + Resource Timing, console errors, a screenshot, and a raw CDP
 * Performance.getMetrics snapshot. Pure measurement — no MCP/protocol code here.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
//  METRIC DICTIONARY — plain-English teaching content for a brand-new user.
//  These are the LIVE numbers a real browser saw (field-style), as opposed to
//  Lighthouse's lab score. Thresholds are Google's Core Web Vitals cutoffs.
// ---------------------------------------------------------------------------
export const METRICS = {
  fcp:  { label: 'FCP',  name: 'First Contentful Paint',
    what: 'When the first text or image actually appeared in this browser.',
    why: 'Proof to the visitor that the page is working, not frozen.', good: 1800, poor: 3000, unit: 'ms' },
  lcp:  { label: 'LCP',  name: 'Largest Contentful Paint',
    what: 'When the biggest element finished painting — the page looked ready.',
    why: 'The headline "is it loaded yet" moment for a real visitor.', good: 2500, poor: 4000, unit: 'ms' },
  cls:  { label: 'CLS',  name: 'Cumulative Layout Shift',
    what: 'How much things jumped around while the page settled.',
    why: 'Jumpiness causes mis-clicks and feels low quality. 0 = nothing moved.', good: 0.1, poor: 0.25, unit: '' },
  ttfb: { label: 'TTFB', name: 'Time to First Byte',
    what: 'How long the server took to send the first byte.',
    why: 'A slow server delays everything that follows.', good: 800, poor: 1800, unit: 'ms' },
  domContentLoaded: { label: 'DCL', name: 'DOM Content Loaded',
    what: 'When the HTML was parsed and the DOM was ready.',
    why: 'Scripts that wait for the DOM can start now.', good: 2000, poor: 4000, unit: 'ms' },
  load: { label: 'Load', name: 'Page Load',
    what: 'When everything (images, styles, scripts) finished loading.',
    why: 'The classic "page fully loaded" wall-clock time.', good: 3400, poor: 5800, unit: 'ms' },
};

// value -> band level (lower is better for every CDP metric here).
export function band(key, value) {
  const m = METRICS[key];
  if (!m || value == null) return { level: 'na', emoji: '⚪', text: 'No data' };
  if (value <= m.good) return { level: 'good', emoji: '🟢', text: 'Good' };
  if (value <= m.poor) return { level: 'average', emoji: '🟡', text: 'Needs improvement' };
  return { level: 'poor', emoji: '🔴', text: 'Poor' };
}

export function explainMetric(key) {
  const m = METRICS[key];
  if (!m) return null;
  const fmt = (v) => (m.unit === 'ms' ? `${v} ms` : `${v}`);
  return {
    key, label: m.label, name: m.name, what: m.what, why: m.why,
    rule: `Good when ≤ ${fmt(m.good)}; Poor when ≥ ${fmt(m.poor)}.`,
  };
}

// Launch a browser already on the machine (Playwright's own download is often
// blocked on corporate networks): try Chrome, then Edge, then bundled chromium.
async function launchBrowser() {
  let lastErr;
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try { return await chromium.launch({ headless: true, ...opts }); }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('No usable browser. Install Chrome/Edge, or run: npx playwright install chromium');
}

// ---------------------------------------------------------------------------
//  Capture live metrics for a URL. Optionally include the resource waterfall,
//  a screenshot, and a raw CDP Performance.getMetrics snapshot.
// ---------------------------------------------------------------------------
export async function capture(url, { device = 'desktop', screenshot = false, waterfall = false, cdpMetrics = false } = {}) {
  const browser = await launchBrowser();
  const consoleErrors = [];
  try {
    const context = await browser.newContext({
      viewport: device === 'mobile' ? { width: 412, height: 823 } : { width: 1350, height: 940 },
    });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    // Optional raw CDP session (Chromium only) for Performance.getMetrics.
    let cdpSession = null;
    if (cdpMetrics) {
      try { cdpSession = await context.newCDPSession(page); await cdpSession.send('Performance.enable'); }
      catch (_) { cdpSession = null; }
    }

    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1200); // let late paints / layout shifts register

    const data = await page.evaluate(() => {
      const out = { fcp: null, lcp: null, cls: 0, ttfb: null, domContentLoaded: null, load: null, resources: [], transferBytes: 0, totalRequests: null };
      for (const e of performance.getEntriesByType('paint')) {
        if (e.name === 'first-contentful-paint') out.fcp = Math.round(e.startTime);
      }
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        out.ttfb = Math.round(nav.responseStart);
        out.domContentLoaded = Math.round(nav.domContentLoadedEventEnd);
        out.load = Math.round(nav.loadEventEnd || nav.duration);
      }
      const lcps = performance.getEntriesByType('largest-contentful-paint');
      if (lcps.length) out.lcp = Math.round(lcps[lcps.length - 1].startTime);
      let cls = 0;
      for (const e of performance.getEntriesByType('layout-shift')) { if (!e.hadRecentInput) cls += e.value; }
      out.cls = Math.round(cls * 1000) / 1000;
      const res = performance.getEntriesByType('resource').map((r) => ({
        name: r.name, type: r.initiatorType, duration: Math.round(r.duration),
        size: Math.round(r.transferSize || 0), start: Math.round(r.startTime),
      }));
      out.resources = res.sort((a, b) => b.size - a.size).slice(0, 30);
      out.transferBytes = res.reduce((a, r) => a + r.size, 0);
      out.totalRequests = res.length + 1;
      return out;
    }).catch(() => ({}));

    let shot = null;
    if (screenshot) {
      try { shot = 'data:image/jpeg;base64,' + (await page.screenshot({ type: 'jpeg', quality: 55 })).toString('base64'); }
      catch (_) {}
    }

    let rawCdp = null;
    if (cdpSession) {
      try {
        const { metrics } = await cdpSession.send('Performance.getMetrics');
        rawCdp = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
      } catch (_) {}
    }

    const metrics = {};
    for (const key of Object.keys(METRICS)) {
      const value = data[key] ?? null;
      const b = band(key, value);
      metrics[key] = { value, level: b.level, emoji: b.emoji, rating: b.text };
    }

    return {
      url,
      finalUrl: page.url(),
      metrics,
      totalRequests: data.totalRequests ?? null,
      transferKb: data.transferBytes ? Math.round(data.transferBytes / 1024) : null,
      consoleErrors: consoleErrors.length,
      consoleErrorSamples: consoleErrors.slice(0, 5),
      resources: waterfall ? (data.resources || []) : [],
      screenshot: shot,
      cdpRawMetrics: rawCdp,
    };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}
