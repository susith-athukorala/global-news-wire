#!/usr/bin/env node
/**
 * cron-pipeline.js
 *
 * Runs inside GitHub Actions on a schedule:
 *   1. Pulls a set of international RSS feeds.
 *   2. Cleans titles and descriptions with plain code (no AI).
 *   3. Drops anything already in data.json, matched by cleaned URL.
 *   4. Merges, sorts newest-first, caps at MAX_ARTICLES and writes data.json.
 *   5. Fetches exchange rates and oil prices and writes meta.json, together
 *      with the time of this run.
 *
 * No API keys or secrets are needed.
 *   Exchange rates: ExchangeRate-API open endpoint (daily, attribution required).
 *   Oil: U.S. EIA daily spot prices via FRED (previous trading day).
 */

'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const Parser = require('rss-parser');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATA_FILE = path.join(__dirname, 'data.json');
const META_FILE = path.join(__dirname, 'meta.json');

// Currencies shown on the site, quoted against the US dollar.
const FX_CODES = ['AUD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'LKR'];
const FX_URL = 'https://open.er-api.com/v6/latest/USD';

// FRED series of U.S. EIA daily spot prices, USD per barrel.
const OIL_SERIES = {
  brent: 'DCOILBRENTEU',
  wti: 'DCOILWTICO'
};

const MAX_ARTICLES = 150;         // size of the public archive
const MAX_ITEM_AGE_HOURS = 48;    // ignore stale items still sitting in feeds
const MAX_PER_FEED = 10;          // stops one busy feed from filling the archive
const FEED_TIMEOUT_MS = 15000;

const CATEGORIES = ['World', 'Technology', 'Economy', 'Science', 'Health'];

// Direct feeds from established news organisations only. No aggregators:
// every article link must belong to the publisher's own domain (`domains`),
// or it is dropped. Each feed carries its own category.
//
// Not included, on purpose:
//   Reuters - no public RSS since 2020; only reachable via Google News.
//   CNN     - rss.cnn.com stopped updating in 2023-24; same problem.
const FEEDS = [
  // World
  { name: 'BBC News',      category: 'World',      domains: ['bbc.co.uk', 'bbc.com'],  url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'The Guardian',  category: 'World',      domains: ['theguardian.com'],       url: 'https://www.theguardian.com/world/rss' },
  { name: 'Al Jazeera',    category: 'World',      domains: ['aljazeera.com'],         url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'NPR',           category: 'World',      domains: ['npr.org'],               url: 'https://feeds.npr.org/1004/rss.xml' },
  { name: 'ABC Australia', category: 'World',      domains: ['abc.net.au'],            url: 'https://www.abc.net.au/news/feed/104217382/rss.xml' },
  { name: 'ABC News (US)', category: 'World',      domains: ['abcnews.go.com', 'abcnews.com'], url: 'https://abcnews.go.com/abcnews/internationalheadlines' },

  // Technology
  { name: 'BBC News',      category: 'Technology', domains: ['bbc.co.uk', 'bbc.com'],  url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { name: 'The Guardian',  category: 'Technology', domains: ['theguardian.com'],       url: 'https://www.theguardian.com/uk/technology/rss' },
  { name: 'NPR',           category: 'Technology', domains: ['npr.org'],               url: 'https://feeds.npr.org/1019/rss.xml' },

  // Economy
  { name: 'BBC News',      category: 'Economy',    domains: ['bbc.co.uk', 'bbc.com'],  url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'The Guardian',  category: 'Economy',    domains: ['theguardian.com'],       url: 'https://www.theguardian.com/uk/business/rss' },
  { name: 'ABC Australia', category: 'Economy',    domains: ['abc.net.au'],            url: 'https://www.abc.net.au/news/feed/104217374/rss.xml' },

  // Science
  { name: 'BBC News',      category: 'Science',    domains: ['bbc.co.uk', 'bbc.com'],  url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
  { name: 'The Guardian',  category: 'Science',    domains: ['theguardian.com'],       url: 'https://www.theguardian.com/science/rss' },
  { name: 'NPR',           category: 'Science',    domains: ['npr.org'],               url: 'https://feeds.npr.org/1007/rss.xml' },

  // Health
  { name: 'BBC News',      category: 'Health',     domains: ['bbc.co.uk', 'bbc.com'],  url: 'https://feeds.bbci.co.uk/news/health/rss.xml' },
  { name: 'NPR',           category: 'Health',     domains: ['npr.org'],               url: 'https://feeds.npr.org/1128/rss.xml' }
];

// Reported news only: skip opinion, live blogs, video/audio, galleries,
// quizzes, newsletters and sponsored content.
const EXCLUDE_URL = [
  /\/opinions?\//i, /\/commentisfree\//i, /\/comment\//i, /\/editorials?\//i,
  /\/live\//i, /\/liveblog/i, /\/video[s]?\//i, /\/av\//i, /\/sounds\//i,
  /\/audio\//i, /\/podcasts?\//i, /\/programmes\//i, /\/gallery\//i,
  /\/in-pictures\//i, /\/picture\//i, /\/newsletters?\//i, /\/crosswords\//i,
  /\/quiz/i, /\/sponsored\//i, /\/advertis/i, /\/partner-content\//i
];
const EXCLUDE_TITLE = [
  /^(opinion|comment|editorial|letters?|analysis|live|watch|video|podcast|quiz|sponsored|in pictures|photos?)\s*[:|–—-]/i,
  /\b(live updates?|as it happened|– live|- live)\b/i,
  /\bquiz\b/i
];

function isAllowedDomain(link, domains) {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

function isReportedNews(rawTitle, link) {
  return !EXCLUDE_URL.some((re) => re.test(link)) && !EXCLUDE_TITLE.some((re) => re.test(rawTitle));
}

// Lets the purge step drop archived items from sources no longer in FEEDS.
const ALLOWED_DOMAINS = [...new Set(FEEDS.flatMap((f) => f.domains))];

// Query parameters that only exist for tracking and should not affect identity.
const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^msclkid$/i, /^mc_cid$/i,
  /^mc_eid$/i, /^at_medium$/i, /^at_campaign$/i, /^at_custom\d*$/i, /^ocid$/i,
  /^cmpid$/i, /^ref$/i, /^ref_src$/i, /^guccounter$/i, /^_hsenc$/i, /^_hsmi$/i
];

// Boilerplate that feeds append to descriptions.
const BOILERPLATE = [
  /\bthe post .+? appeared first on .+?\.?$/i,
  /\bcontinue reading\b.*$/i,
  /\bread more\b.*$/i,
  /\bclick here\b.*$/i,
  /\bsubscribe (now|today|to)\b.*$/i,
  /\bsign up for\b.*$/i,
  /\[\s*(…|\.\.\.)\s*\]$/,
  /\s*(…|\.\.\.)$/
];

// Teaser openers. These are only removed from the start of a headline, and
// only when real words remain afterwards.
const CLICKBAIT_PREFIXES = [
  /^(breaking|watch|video|live|exclusive|opinion|analysis|explainer|in pictures|update[sd]?)\s*[:|–—-]\s*/i,
  /^(shocking|revealed|you won'?t believe)\s*[:|–—-]?\s*/i
];

// ---------------------------------------------------------------------------
// Cleaning helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', pound: '£', euro: '€'
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Strips tags and entities, collapses whitespace. Runs decoding twice for double-encoded feeds. */
function stripHtml(text) {
  if (!text) return '';
  let out = String(text)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  out = decodeEntities(out).replace(/<[^>]*>/g, ' ');
  out = decodeEntities(out).replace(/<[^>]*>/g, ' ');
  return out.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanTitle(raw, sourceName) {
  let title = stripHtml(raw);
  // Google News appends " - Publisher" to every headline.
  title = title.replace(/\s+[-–—|]\s+(Reuters|BBC News|Al Jazeera|TechCrunch|CNN|CNN International|ABC News)$/i, '');
  for (const re of CLICKBAIT_PREFIXES) {
    const next = title.replace(re, '');
    if (next.split(' ').length >= 3) title = next;
  }
  title = title.replace(/!+/g, '').replace(/\s+/g, ' ').trim();
  if (title && title === title.toUpperCase() && /[A-Z]{4,}/.test(title)) {
    // All-caps headline: convert to sentence case.
    title = title.charAt(0) + title.slice(1).toLowerCase();
  }
  return title.slice(0, 200);
}

/** First one or two sentences of the description, without boilerplate. */
/**
 * Returns the first real paragraph of a description. Feeds such as The
 * Guardian pack a standfirst, a list of related links and the opening
 * paragraphs into one HTML block; flattening it naively runs them together.
 */
function firstParagraph(raw) {
  if (!raw) return '';
  let html = decodeEntities(String(raw).replace(/<!\[CDATA\[|\]\]>/g, ''));
  html = html
    .replace(/<(ul|ol|figure|figcaption|aside|table)[\s\S]*?<\/\1>/gi, '\n') // related-link lists, captions
    .replace(/<a\b[^>]*>\s*(continue reading|read more)[\s\S]*?<\/a>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>|<br\s*\/?>/gi, '\n');
  const paragraphs = stripHtmlKeepLines(html)
    .split('\n')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 30);
  return paragraphs[0] || '';
}

function stripHtmlKeepLines(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ');
}

function cleanSummary(raw, title) {
  const hasHtml = /<\s*(p|br|div|ul|li)\b/i.test(String(raw || ''));
  let text = hasHtml ? firstParagraph(raw) : stripHtml(raw);
  for (const re of BOILERPLATE) text = text.replace(re, '').trim();
  if (!text) return '';

  // Google News descriptions only repeat the headline and publisher.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (norm(text).startsWith(norm(title).slice(0, 40))) return '';

  // Split only where end punctuation is followed by a space and a capital,
  // so "7.1" or "$3.5bn" stay intact. Re-join splits after abbreviations.
  const pieces = text.split(/(?<=[.!?]["'’”]?)\s+(?=[A-Z"'‘“])/);
  const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|St|Gen|Sen|Rep|Gov|Lt|Col|Sgt|Inc|Ltd|Co|Corp|Jr|Sr|vs|No|U\.S|U\.K|U\.N|E\.U)\.$/;
  const sentences = [];
  for (const piece of pieces) {
    const last = sentences[sentences.length - 1];
    if (last && ABBREV.test(last)) sentences[sentences.length - 1] = last + ' ' + piece.trim();
    else sentences.push(piece.trim());
  }
  let summary = sentences.slice(0, 2).join(' ').trim();
  if (summary.length > 320) {
    summary = summary.slice(0, 317).replace(/\s+\S*$/, '') + '…';
  } else if (!/[.!?…"'’”)]$/.test(summary)) {
    summary += '.'; // standfirsts often have no full stop
  }
  return summary;
}

function cleanUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch (_) {
    return null;
  }
}

function toIsoDate(item) {
  const candidate = item.isoDate || item.pubDate || item.published || item.updated;
  const d = candidate ? new Date(candidate) : null;
  return d && !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log(`Warning: could not parse ${path.basename(file)} (${err.message}). Starting with an empty array.`);
    }
    return [];
  }
}

async function writeJsonIfChanged(file, value) {
  const next = JSON.stringify(value, null, 2) + '\n';
  let prev = null;
  try { prev = await fs.readFile(file, 'utf8'); } catch (_) { /* new file */ }
  if (prev === next) return false;
  await fs.writeFile(file, next, 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchAllFeeds() {
  const parser = new Parser({
    timeout: FEED_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GlobalNewsWireBot/1.0)' }
  });

  const settled = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const parsed = await parser.parseURL(feed.url);
      const raw = parsed.items || [];
      const kept = [];
      let skippedType = 0;
      let skippedDomain = 0;
      for (const item of raw) {
        const link = cleanUrl(item.link || item.guid);
        const rawTitle = stripHtml(item.title);
        if (!link || !rawTitle) continue;
        if (!isAllowedDomain(link, feed.domains)) { skippedDomain++; continue; }
        if (!isReportedNews(rawTitle, link)) { skippedType++; continue; }
        const title = cleanTitle(item.title, feed.name);
        kept.push({
          title,
          // Prefer the HTML version so paragraph breaks survive; fall back to plain text.
          summary: cleanSummary(item.content || item.description || item.contentSnippet || item.summary, title),
          category: CATEGORIES.includes(feed.category) ? feed.category : 'World',
          source: feed.name,
          link,
          publishedAt: toIsoDate(item),
          _feed: `${feed.name}/${feed.category}`
        });
      }
      return { kept, total: raw.length, skippedType, skippedDomain };
    })
  );

  const items = [];
  let okCount = 0;
  settled.forEach((result, i) => {
    const label = `${FEEDS[i].name} (${FEEDS[i].category})`;
    if (result.status === 'fulfilled') {
      okCount++;
      const r = result.value;
      log(`Fetched ${r.total} items from ${label}: kept ${r.kept.length}, ` +
          `skipped ${r.skippedType} opinion/live/video, ${r.skippedDomain} off-domain`);
      items.push(...r.kept);
    } else {
      log(`Feed failed: ${label} -> ${result.reason && result.reason.message}`);
    }
  });

  return { items: items.filter((it) => it.link && it.title), okCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const loaded = await readJsonArray(DATA_FILE);
  // Drop archived items that no longer meet the source and content rules,
  // e.g. old Google News / CNN entries or opinion pieces from earlier runs.
  const existing = loaded
    .filter((a) => a && a.link && a.title && isAllowedDomain(a.link, ALLOWED_DOMAINS) && isReportedNews(a.title, a.link))
    // Older runs labelled BBC items by feed ("BBC World", "BBC Business"...).
    .map((a) => (/^BBC\b/.test(a.source) && a.source !== 'BBC News' ? { ...a, source: 'BBC News' } : a))
    // Older runs produced long run-on summaries for Guardian items, cut off with
    // an ellipsis. They cannot be repaired from the archive, so blank them;
    // those items age out within a day or two anyway.
    .map((a) => (a.summary && /…$/.test(a.summary) && a.summary.length > 280 ? { ...a, summary: '' } : a));
  if (existing.length < loaded.length) {
    log(`Purged ${loaded.length - existing.length} archived items that fail the source rules.`);
  }
  const knownLinks = new Set(existing.map((a) => a && a.link).filter(Boolean));
  // The same story often appears in two feeds under slightly different URLs.
  const titleKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);
  const knownTitles = new Set(existing.map((a) => a && a.title && titleKey(a.title)).filter(Boolean));
  log(`Loaded ${existing.length} archived articles.`);

  const { items, okCount } = await fetchAllFeeds();
  if (okCount === 0) {
    console.error('Every feed failed. Leaving data.json untouched.');
    process.exit(1);
  }

  const ageCutoff = Date.now() - MAX_ITEM_AGE_HOURS * 3600 * 1000;
  const perFeed = {};
  const fresh = [];

  items
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .forEach((it) => {
      const key = titleKey(it.title);
      if (knownLinks.has(it.link) || knownTitles.has(key)) return;
      if (new Date(it.publishedAt).getTime() < ageCutoff) return;
      perFeed[it._feed] = (perFeed[it._feed] || 0) + 1;
      if (perFeed[it._feed] > MAX_PER_FEED) return;
      knownLinks.add(it.link);
      knownTitles.add(key);
      const { _feed, ...article } = it;
      fresh.push({
        id: crypto.createHash('sha1').update(it.link).digest('hex').slice(0, 16),
        ...article
      });
    });

  log(`${fresh.length} new articles after cleaning and de-duplication.`);

  const merged = [...fresh, ...existing]
    .filter((a) => a && a.link && a.title)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MAX_ARTICLES);

  const changed = await writeJsonIfChanged(DATA_FILE, merged);
  log(`data.json ${changed ? 'updated' : 'unchanged'} (${merged.length} articles).`);

  // Markets and run status. A failed source keeps its last good values.
  const prevMeta = await readJsonObject(META_FILE);
  const [fx, oil] = await Promise.all([
    fetchFx(prevMeta.fx).catch((err) => {
      log(`Exchange rates failed: ${err.message}. Keeping previous values.`);
      return prevMeta.fx || null;
    }),
    fetchOil(prevMeta.oil).catch((err) => {
      log(`Oil prices failed: ${err.message}. Keeping previous values.`);
      return prevMeta.oil || null;
    })
  ]);

  const meta = {
    lastRun: new Date().toISOString(),
    feedsOk: okCount,
    feedsTotal: FEEDS.length,
    articleCount: merged.length,
    fx,
    oil
  };
  await writeJsonIfChanged(META_FILE, meta);
  log(`meta.json written (feeds ${okCount}/${FEEDS.length}).`);
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

async function readJsonObject(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GlobalNewsWireBot/1.0)' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.text();
}

/**
 * Daily rates per 1 USD. The provider updates once a day, so the previous
 * day's snapshot is kept to work out the daily change.
 */
async function fetchFx(prevFx) {
  const body = JSON.parse(await fetchText(FX_URL));
  if (body.result !== 'success' || !body.rates) {
    throw new Error(body['error-type'] || 'unexpected response');
  }

  const rates = {};
  for (const code of FX_CODES) {
    const value = Number(body.rates[code]);
    if (Number.isFinite(value) && value > 0) rates[code] = value;
  }
  const updated = new Date(body.time_last_update_unix * 1000).toISOString();

  let previous = prevFx && prevFx.previous ? prevFx.previous : null;
  if (prevFx && prevFx.updated && prevFx.updated !== updated && prevFx.rates) {
    previous = { updated: prevFx.updated, rates: prevFx.rates };
  }

  log(`Exchange rates as of ${updated}.`);
  return { base: 'USD', updated, rates, previous };
}

/** Last two observations of a FRED series, skipping blank days ("."). */
async function fetchFredSeries(id) {
  const start = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`);
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(','))
    .filter((cols) => /^\d{4}-\d{2}-\d{2}$/.test(cols[0]) && Number.isFinite(parseFloat(cols[1])));
  if (rows.length < 1) throw new Error(`no data for ${id}`);
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return {
    price: parseFloat(last[1]),
    date: last[0],
    previous: prev ? parseFloat(prev[1]) : null,
    previousDate: prev ? prev[0] : null
  };
}

async function fetchOil(prevOil) {
  const out = { source: 'U.S. EIA via FRED', unit: 'USD per barrel' };
  let okCount = 0;
  for (const [key, id] of Object.entries(OIL_SERIES)) {
    try {
      out[key] = await fetchFredSeries(id);
      okCount++;
    } catch (err) {
      log(`Oil series ${id} failed: ${err.message}.`);
      out[key] = prevOil && prevOil[key] ? prevOil[key] : null;
    }
  }
  if (okCount === 0 && !(prevOil && (prevOil.brent || prevOil.wti))) throw new Error('both oil series failed');
  log(`Oil: Brent ${out.brent ? out.brent.price : 'n/a'}, WTI ${out.wti ? out.wti.price : 'n/a'}.`);
  return out;
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
