/*
 * engine.js — the Lighthouse measurement core for the MCP server.
 *
 * Pure functions + one audit runner. No MCP/protocol code lives here, so it can
 * be tested on its own. server.js wraps these in MCP tools.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');
// lighthouse 12+ is ESM — its callable is the default export.
const lighthouse = (await import('lighthouse')).default;

// ---------------------------------------------------------------------------
//  METRIC DICTIONARY — plain-English teaching content for a brand-new user.
//  Each metric: what it is, why it matters, and the Good / Poor thresholds
//  (Google's official Core Web Vitals + Lighthouse cutoffs).
// ---------------------------------------------------------------------------
export const METRICS = {
  lcp: {
    label: 'LCP', name: 'Largest Contentful Paint', lhId: 'largest-contentful-paint', unit: 's',
    what: 'How long until the biggest thing on screen (usually the hero image or main headline) is fully shown.',
    why: 'This is the moment the page LOOKS ready to the visitor. It is the headline performance number.',
    good: 2500, poor: 4000,
  },
  fcp: {
    label: 'FCP', name: 'First Contentful Paint', lhId: 'first-contentful-paint', unit: 's',
    what: 'How long until the FIRST piece of content (any text or image) appears.',
    why: 'A blank screen feels broken. First paint is the visitor’s first proof the page is working.',
    good: 1800, poor: 3000,
  },
  cls: {
    label: 'CLS', name: 'Cumulative Layout Shift', lhId: 'cumulative-layout-shift', unit: '',
    what: 'How much the page jumps around while it loads (a button moves just as you go to tap it).',
    why: 'Unexpected movement makes people mis-tap and feels low quality. 0 means nothing moved.',
    good: 0.1, poor: 0.25,
  },
  tbt: {
    label: 'TBT', name: 'Total Blocking Time', lhId: 'total-blocking-time', unit: 'ms',
    what: 'How long the page was frozen and unable to respond to clicks while it was busy running code.',
    why: 'A page can LOOK ready but ignore your clicks. High TBT means a frustrating, unresponsive feel.',
    good: 200, poor: 600,
  },
  si: {
    label: 'SI', name: 'Speed Index', lhId: 'speed-index', unit: 's',
    what: 'How quickly the page visually fills in from blank to complete.',
    why: 'Captures the overall “it loaded fast” feeling, not just one single moment.',
    good: 3400, poor: 5800,
  },
  tti: {
    label: 'TTI', name: 'Time to Interactive', lhId: 'interactive', unit: 's',
    what: 'How long until the page is fully usable — every button and link reliably responds.',
    why: 'This is when the visitor can actually start doing things, not just looking.',
    good: 3800, poor: 7300,
  },
};

export const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

// A 0..100 score (or 0..1 fraction) -> a simple band a newcomer understands.
export function band(score) {
  if (score == null) return { level: 'na', emoji: '⚪', text: 'No data' };
  const s = score <= 1 ? score * 100 : score;
  if (s >= 90) return { level: 'good', emoji: '🟢', text: 'Good' };
  if (s >= 50) return { level: 'average', emoji: '🟡', text: 'Needs improvement' };
  return { level: 'poor', emoji: '🔴', text: 'Poor' };
}

// Plain-English verdict for the overall performance score.
export function verdict(perfScore) {
  if (perfScore == null) return 'We could not measure performance for this page.';
  if (perfScore >= 90) return 'Fast for a single visitor. Most users will have a smooth experience.';
  if (perfScore >= 50) return 'Okay, but has room to improve. Some users will notice waiting.';
  return 'Slow for a single visitor. Users are likely to wait noticeably and may leave.';
}

// The teaching payload for one metric (used by the explain_metric tool).
export function explainMetric(key) {
  const m = METRICS[key];
  if (!m) return null;
  const goodTxt = m.unit === 's' ? `${(m.good / 1000).toFixed(1)} s` : m.unit === 'ms' ? `${m.good} ms` : `${m.good}`;
  const poorTxt = m.unit === 's' ? `${(m.poor / 1000).toFixed(1)} s` : m.unit === 'ms' ? `${m.poor} ms` : `${m.poor}`;
  return {
    key, label: m.label, name: m.name,
    what: m.what, why: m.why,
    goodThreshold: goodTxt, poorThreshold: poorTxt,
    rule: `Good when ≤ ${goodTxt}; Poor when ≥ ${poorTxt}.`,
  };
}

// ---------------------------------------------------------------------------
//  Run one Lighthouse audit and shape the result into clean, explained data.
// ---------------------------------------------------------------------------
export async function runAudit(url, { device = 'desktop', throttling = false } = {}) {
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'] });
  try {
    const settings = {
      onlyCategories: CATEGORIES,
      formFactor: device === 'mobile' ? 'mobile' : 'desktop',
      screenEmulation: device === 'mobile'
        ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
        : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    };
    if (!throttling) {
      settings.throttlingMethod = 'provided';
      settings.throttling = { rttMs: 0, throughputKbps: 0, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 };
    }
    const result = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, { extends: 'lighthouse:default', settings });
    if (!result?.lhr) throw new Error('Lighthouse returned no result');
    return shapeResult(result.lhr, url);
  } finally {
    // chrome.kill() can throw EPERM on Windows during temp cleanup — never let
    // a teardown error discard a completed audit.
    try { await chrome.kill(); } catch (_) {}
  }
}

function shapeResult(lhr, url) {
  const metrics = Object.entries(METRICS).map(([key, info]) => {
    const audit = lhr.audits[info.lhId];
    const score = audit?.score == null ? null : Math.round(audit.score * 100);
    const b = band(score);
    return {
      key, label: info.label, name: info.name,
      value: audit?.displayValue || 'n/a',
      numeric: audit?.numericValue ?? null,
      score, level: b.level, emoji: b.emoji, rating: b.text,
      what: info.what, why: info.why,
    };
  });

  const categories = CATEGORIES
    .filter((k) => lhr.categories?.[k])
    .map((k) => {
      const score = Math.round((lhr.categories[k].score ?? 0) * 100);
      const b = band(score);
      return { key: k, label: lhr.categories[k].title, score, level: b.level, emoji: b.emoji, rating: b.text };
    });

  const perf = categories.find((c) => c.key === 'performance');
  const perfScore = perf ? perf.score : null;

  return {
    url,
    finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || url,
    testedAt: lhr.fetchTime,
    performanceScore: perfScore,
    verdict: verdict(perfScore),
    categories,
    metrics,
    opportunities: topOpportunities(lhr),
  };
}

// Lighthouse's own ranked suggestions, by estimated time saved.
function topOpportunities(lhr) {
  return Object.values(lhr.audits)
    .filter((a) => a.details?.type === 'opportunity' && a.details.overallSavingsMs > 0)
    .sort((a, b) => b.details.overallSavingsMs - a.details.overallSavingsMs)
    .slice(0, 6)
    .map((a) => ({ title: a.title, saveMs: Math.round(a.details.overallSavingsMs) }));
}
