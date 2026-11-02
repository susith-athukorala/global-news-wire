#!/usr/bin/env node
/**
 * cron-pipeline.js
 *
 * Runs inside GitHub Actions on a schedule:
 *   1. Pulls a set of international RSS feeds.
 *   2. Cleans titles and descriptions with plain code (no AI).
 *   3. Drops anything already in data.json, matched by cleaned URL.
 *   4. Merges, sorts newest-first, caps at MAX_ARTICLES and writes data.json.
 *
 * No API keys or secrets are needed.
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

const MAX_ARTICLES = 100;         // size of the public archive
const MAX_ITEM_AGE_HOURS = 48;    // ignore stale items still sitting in feeds
const MAX_PER_FEED = 15;          // stops one busy feed from filling the archive
const FEED_TIMEOUT_MS = 15000;

const CATEGORIES = ['World', 'Technology', 'Economy', 'Science', 'Health'];

// Each feed carries its own category. This is simpler and more predictable
// than guessing from keywords. Reuters closed its public RSS feeds in 2020, so
// that entry uses a Google News search restricted to reuters.com; its links
// open a news.google.com redirect page.
const FEEDS = [
  { name: 'BBC World',      category: 'World',      url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Reuters',        category: 'World',      url: 'https://news.google.com/rss/search?q=site%3Areuters.com+when%3A1d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Al Jazeera',     category: 'World',      url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'TechCrunch',     category: 'Technology', url: 'https://techcrunch.com/feed/' },
  { name: 'BBC Technology', category: 'Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { name: 'BBC Business',   category: 'Economy',    url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'BBC Science',    category: 'Science',    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
  { name: 'BBC Health',     category: 'Health',     url: 'https://feeds.bbci.co.uk/news/health/rss.xml' }
];

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
  title = title.replace(/\s+[-–—|]\s+(Reuters|BBC News|Al Jazeera|TechCrunch)$/i, '');
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
function cleanSummary(raw, title) {
  let text = stripHtml(raw);
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
      return (parsed.items || []).slice(0, MAX_PER_FEED * 2).map((item) => {
        const title = cleanTitle(item.title, feed.name);
        return {
          title,
          summary: cleanSummary(item.contentSnippet || item.summary || item.content || item.description, title),
          category: CATEGORIES.includes(feed.category) ? feed.category : 'World',
          source: feed.name,
          link: cleanUrl(item.link || item.guid),
          publishedAt: toIsoDate(item)
        };
      });
    })
  );

  const items = [];
  let okCount = 0;
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      okCount++;
      log(`Fetched ${result.value.length} items from ${FEEDS[i].name}`);
      items.push(...result.value);
    } else {
      log(`Feed failed: ${FEEDS[i].name} -> ${result.reason && result.reason.message}`);
    }
  });

  return { items: items.filter((it) => it.link && it.title), okCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const existing = await readJsonArray(DATA_FILE);
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
      perFeed[it.source] = (perFeed[it.source] || 0) + 1;
      if (perFeed[it.source] > MAX_PER_FEED) return;
      knownLinks.add(it.link);
      knownTitles.add(key);
      fresh.push({
        id: crypto.createHash('sha1').update(it.link).digest('hex').slice(0, 16),
        ...it
      });
    });

  log(`${fresh.length} new articles after cleaning and de-duplication.`);

  const merged = [...fresh, ...existing]
    .filter((a) => a && a.link && a.title)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MAX_ARTICLES);

  const changed = await writeJsonIfChanged(DATA_FILE, merged);
  log(`data.json ${changed ? 'updated' : 'unchanged'} (${merged.length} articles).`);
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
