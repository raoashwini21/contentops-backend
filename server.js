import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Multer for multipart image uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ════════════════════════════════════════════
// MULTI-LAYER CACHE SYSTEM
// ════════════════════════════════════════════
const blogCache = new Map();
const BLOG_CACHE_TTL = 10 * 60 * 1000;
const searchResultsCache = new Map();
const SEARCH_CACHE_TTL = 60 * 60 * 1000;
const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 24 * 60 * 60 * 1000;

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function getFromCache(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.timestamp) >= ttl) return null;
  return cache.get(key).data;
}

function setCache(cache, key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of blogCache.entries()) { if (now - value.timestamp > BLOG_CACHE_TTL) blogCache.delete(key); }
  for (const [key, value] of searchResultsCache.entries()) { if (now - value.timestamp > SEARCH_CACHE_TTL) searchResultsCache.delete(key); }
  for (const [key, value] of analysisCache.entries()) { if (now - value.timestamp > ANALYSIS_CACHE_TTL) analysisCache.delete(key); }
}, 5 * 60 * 1000);

// ════════════════════════════════════════════
// RATE LIMITING
// ════════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (record.count >= MAX_REQUESTS_PER_WINDOW) return false;
  record.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) rateLimitMap.delete(ip);
  }
}, 2 * 60 * 1000);

// ════════════════════════════════════════════
// FETCH WITH TIMEOUT & RETRY
// ════════════════════════════════════════════
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      if (attempt === retries) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`Retry ${attempt}/${retries} after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function fetchAllBlogs(collectionId, token) {
  console.log('Fetching blogs from Webflow...');
  const items = [];
  let offset = 0;
  while (true) {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100&offset=${offset}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
    }, 30000, 3);
    if (!res.ok) { const errorText = await res.text(); throw new Error(`Webflow ${res.status}: ${errorText}`); }
    const data = await res.json();
    const batch = data.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 300));
  }
  const seen = new Set();
  return items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
}

// ════════════════════════════════════════════
// WIDGET PROTECTION (nested-tag-aware)
// ════════════════════════════════════════════
function protectWidgets(html) {
  const widgets = [];

  function extractBlock(src, startIdx, tagName) {
    const openTag = '<' + tagName;
    const closeTag = '</' + tagName + '>';
    const openLen = openTag.length;
    const closeLen = closeTag.length;
    let depth = 1;
    const firstClose = src.indexOf('>', startIdx);
    if (firstClose === -1) return null;
    if (src[firstClose - 1] === '/') return src.substring(startIdx, firstClose + 1);
    let i = firstClose + 1;
    const srcLower = src.toLowerCase();
    const openLower = openTag.toLowerCase();
    const closeLower = closeTag.toLowerCase();
    while (i < src.length && depth > 0) {
      const nextOpen = srcLower.indexOf(openLower, i);
      const nextClose = srcLower.indexOf(closeLower, i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + openLen;
      } else {
        depth--;
        if (depth === 0) return src.substring(startIdx, nextClose + closeLen);
        i = nextClose + closeLen;
      }
    }
    const fb = srcLower.indexOf(closeLower, startIdx + openLen);
    return fb !== -1 ? src.substring(startIdx, fb + closeLen) : null;
  }

  const patterns = [
    /<div[^>]*class="[^"]*(?:w-embed|w-widget|widget|embed)[^"]*"[^>]*>/gi,
    /<table[^>]*/gi,
    /<iframe[^>]*/gi,
    /<script[^>]*/gi,
    /<figure[^>]*/gi,
    /<video[^>]*/gi,
    /<embed[^>]*/gi,
    /<object[^>]*/gi,
  ];

  const found = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const tagMatch = match[0].match(/^<(\w+)/);
      if (!tagMatch) continue;
      const block = extractBlock(html, match.index, tagMatch[1]);
      if (!block) continue;
      const endIdx = match.index + block.length;
      const overlaps = found.some(f =>
        (match.index >= f.start && match.index < f.end) ||
        (endIdx > f.start && endIdx <= f.end)
      );
      if (!overlaps) found.push({ start: match.index, end: endIdx, content: block });
    }
  }

  found.sort((a, b) => a.start - b.start);

  let protectedHtml = html;
  let offset = 0;
  for (const item of found) {
    const id = `___WIDGET_${widgets.length}___`;
    widgets.push(item.content);
    const s = item.start + offset;
    const e = item.end + offset;
    protectedHtml = protectedHtml.substring(0, s) + id + protectedHtml.substring(e);
    offset += id.length - (item.end - item.start);
  }

  // record nearest preceding heading for each widget (anchor for recovery)
  const anchored = widgets.map((content, i) => {
    // find this widget's placeholder position in protectedHtml
    const pos = protectedHtml.indexOf(`___WIDGET_${i}___`);
    let anchor = null;
    if (pos > -1) {
      const before = protectedHtml.substring(0, pos);
      const hMatch = before.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>(?![\s\S]*<h[1-6])/i);
      if (hMatch) anchor = hMatch[0];
    }
    return { content, anchor };
  });

  return { protectedHtml, widgets: anchored };
}

function restoreWidgets(html, widgets) {
  let restored = html;
  const warnings = [];

  widgets.forEach((w, i) => {
    const widget = w.content;
    const exact = `___WIDGET_${i}___`;

    // 1) exact match
    if (restored.includes(exact)) {
      restored = restored.split(exact).join('\u0000PLACEHOLDER\u0000');
      restored = restored.replace('\u0000PLACEHOLDER\u0000', widget);
      restored = restored.split('\u0000PLACEHOLDER\u0000').join('');
      return;
    }

    // 2) tolerant match: escaped underscores, stray spaces, wrapped in tags
    //    matches things like \_\_\_WIDGET\_0\_\_\_, ___ WIDGET_0 ___, <p>___WIDGET_0___</p>
    const tolerant = new RegExp(
      '(?:<p[^>]*>\\s*)?(?:\\\\?_){2,}\\s*WIDGET\\s*(?:\\\\?_)*\\s*' + i + '\\s*(?:\\\\?_){2,}(?:\\s*</p>)?'
    );
    if (tolerant.test(restored)) {
      restored = restored.replace(tolerant, widget);
      // clean any duplicates of the same index
      restored = restored.replace(new RegExp('(?:\\\\?_){2,}\\s*WIDGET\\s*(?:\\\\?_)*\\s*' + i + '\\s*(?:\\\\?_){2,}', 'g'), '');
      console.warn(`  ⚠ Widget ${i}: restored via tolerant match`);
      return;
    }

    // 3) anchor recovery: re-insert right after the heading it originally followed
    if (w.anchor && restored.includes(w.anchor)) {
      restored = restored.replace(w.anchor, w.anchor + '\n' + widget);
      warnings.push(`Widget ${i} placeholder was lost by the model — re-inserted after its original heading. Please verify its position.`);
      console.warn(`  ⚠ Widget ${i}: recovered via heading anchor`);
      return;
    }

    // 4) last resort: append + loud warning
    restored += '\n' + widget;
    warnings.push(`Widget ${i} could not be repositioned — appended at the end of the blog. Please move it back manually.`);
    console.warn(`  ⚠ Widget ${i}: appended at end`);
  });

  return { restored, warnings };
}

// ════════════════════════════════════════════
// WEBFLOW LIST NORMALIZER (server-side guarantee)
// Fixes: editor-created lists nested in <div>/<p> wrappers (Webflow drops
// these silently) and missing role attributes.
// ════════════════════════════════════════════
function normalizeListsForWebflow(html) {
  let out = html;
  // ONLY add role attributes — surgical, zero structural changes.
  // The previous div/p unwrapping regexes used [\s\S]*? which matched across
  // hundreds of lines and broke video embeds and other widgets. Removed permanently.
  out = out.replace(/<ul(?![^>]*\brole=)([^>]*)>/gi, '<ul role="list"$1>');
  out = out.replace(/<ol(?![^>]*\brole=)([^>]*)>/gi, '<ol role="list"$1>');
  out = out.replace(/<li(?![^>]*\brole=)([^>]*)>/gi, '<li role="listitem"$1>');
  return out;
}

// ════════════════════════════════════════════
// FABLE AUDIT — native web search, replaces query-gen + Brave/Google stages
// ════════════════════════════════════════════
async function fableAudit({ anthropicKey, title, blogContent, brandHints, gscKeywords, modelMode }) {
  //const auditModel = modelMode === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-fable-5';
  const auditModel = modelMode === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-8';

  const brandBlock = brandHints?.length
    ? `\nBRAND DISAMBIGUATION:\n${brandHints.join('\n')}\nOnly research the CORRECT product/brand.`
    : '';
  const gscBlock = gscKeywords?.length
    ? `\nGSC KEYWORDS the blog should cover (check which are missing):\n${gscKeywords.map(k => `- "${k.keyword}" (Pos ${k.position}, ${k.clicks} clicks)`).join('\n')}`
    : '';

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: auditModel,
      max_tokens: 6000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: `You are auditing a published SalesRobot blog for factual freshness. Use web search EFFICIENTLY (max 6 targeted searches) — verify by reading official sources (pricing pages, release notes), not aggregator snippets.

TITLE: ${title}

BLOG CONTENT (HTML, widgets replaced by placeholders):
${blogContent}
${brandBlock}${gscBlock}

SALESROBOT SOURCE OF TRUTH (the blog's SalesRobot claims must match this):
${SALESROBOT_FEATURES}

Audit the blog and return ONLY a JSON object (no markdown fences, no commentary):
{
  "findings": [
    {
      "type": "fix" | "add" | "salesrobot",
      "where": "<the heading or section it concerns>",
      "current": "<the exact outdated text in the blog, quoted verbatim — empty string for additions>",
      "corrected": "<the corrected/new text to use, written to match the blog's voice>",
      "reason": "<one line: old vs new value, with source>"
    }
  ],
  "verified": ["<brief list of major claims that checked out — no change needed>"]
}

RULES:
- "fix" = outdated stat/price/feature found via web research
- "add" = missing key info (new PAA-worthy points, GSC keyword gaps) — max 3
- "salesrobot" = SalesRobot section missing must-have features per the source of truth (voice notes, video messages, AI Appointment Setter, cloud/mobile-API safety)
- Quote "current" text VERBATIM so it can be found in the HTML
- If a claim can't be verified either way, leave it alone — do not guess
- Findings must be surgical. This is a refresh, not a rewrite.` }]
    })
  }, 240000, 2);

  if (!res.ok) { const t = await res.text(); throw new Error(`Audit failed ${res.status}: ${t.slice(0, 300)}`); }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const searchesUsed = (data.content || []).filter(b => b.type === 'server_tool_use').length;

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json\n?|```\n?/g, '').trim());
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { findings: [], verified: [] };
  }
  return { ...parsed, searchesUsed, usage: data.usage };
}

// ════════════════════════════════════════════
// SALESROBOT FEATURES — Source of truth
// Sourced directly from salesrobot.co and salesrobot.co/pricing
// Last updated: April 2026
// Update this block whenever features ship or pricing changes.
// ════════════════════════════════════════════
const SALESROBOT_FEATURES = `
SALESROBOT — VERIFIED FEATURES (source: salesrobot.co — use as source of truth for all SalesRobot sections)

CORE LINKEDIN ACTIONS:
- Send connection requests in bulk (up to 75/day on paid plans)
- Send LinkedIn messages and follow-ups automatically
- Send InMails to open profiles (up to 50/day on paid plans, no InMail credits consumed)
- Profile views, post likes, follows, skill endorsements, event invites — all automated
- Comment on prospects' posts automatically
- Import leads from: LinkedIn search, Sales Navigator search, LinkedIn Recruiter, CSV, Google Sheets
- Import leads who are members of a specific LinkedIn group
- Import leads who attended a specific LinkedIn event
- Import everyone who commented on a specific LinkedIn post — then connect with them
- Send PDFs, documents, and attachments in LinkedIn messages

AI VOICE & VIDEO (key differentiator — no other tool does this):
- Send AI-personalized voice notes on LinkedIn at scale (users report 40%+ reply rates)
- Send AI-personalized video messages on LinkedIn at scale — clone yourself, each lead gets a personalized video
- Voice & Video Message Personalization available on all paid plans (up to 50/day)
- This is a unique SalesRobot feature not offered by Expandi, Waalaxy, Dripify, HeyReach, or most competitors

AI APPOINTMENT SETTER (add-on, key differentiator):
- AI agent that replies to leads instantly on your behalf in the LinkedIn inbox
- Nurtures leads and keeps them engaged on LinkedIn until they're ready to book a meeting
- Fully trainable on your company, product, and tone
- Responds within minutes — if you don't reply within 5 mins, chances of converting fall by 50%
- No other LinkedIn automation tool offers this natively
- Available as an add-on across all plans

EMAIL OUTREACH:
- Unlimited cold email automation included
- Works with Gmail, Outlook, and custom SMTP
- Multi-step LinkedIn + Email sequences in a single campaign (true multichannel)
- Unlimited email warmup included

SAFETY (core differentiator):
- Uses LinkedIn mobile app APIs on the backend — reduces ban risk to 0.00001%
- Cloud-based: runs 24/7 even when laptop is closed, no Chrome extension required
- Dedicated, local residential IP rotation per account
- Human-like behavior simulation (randomized delays, working-hours scheduling)
- Compliance with LinkedIn daily limits built in
- Safer than browser-extension tools like Expandi, Waalaxy, Dux-Soup, LinkedHelper

AI & INTELLIGENCE:
- AI Variables: auto-personalizes message copy for each prospect
- Smart Reply Detection (TM): pauses sequences automatically when a lead replies
- Smart Reply Suggestions in inbox
- AI Message Scoring
- Auto-Tagging & Segmentation of leads
- AI Lead Scoring and Filtering (coming soon on Basic, available on Advanced and Professional)
- Dynamic follow-ups with AI personalization

INBOX & CRM:
- Unified inbox: LinkedIn + Email in one place (Advanced and Professional plans)
- Notes and tags on leads (Advanced and Professional)
- Resume leads in sequence
- Save sequences as reusable templates
- Pre-built and customizable sequence templates
- LinkedIn lead transfer to CRM (Advanced and Professional)
- Lead info scraping: email and phone number found from LinkedIn profiles
- Anti-duplication and activity control (Professional only)

INTEGRATIONS:
- Webhooks and Zapier (Advanced and Professional)
- Native HubSpot, Pipedrive, and Salesforce sync (Advanced and Professional)
- Google Sheets and Slack notifications (Advanced and Professional)
- SalesRobot API access for custom integrations
- Custom variables support

ANALYTICS:
- Daily, weekly, monthly stats per campaign
- Real-time campaign performance reports
- Account-level analytics
- Team analytics dashboard (Advanced and Professional)
- A/B testing for message variants (Advanced and Professional)

TEAM & AGENCY:
- Multi-user workspace with roles and permissions (Professional only)
- One-click access to all team/client accounts
- Share sequences and templates across team
- Track team performance and prevent duplicate outreach
- Manage team subscriptions from one dashboard
- Whitelabel: resell SalesRobot under your own brand — 110+ agencies already doing this, earning $10k+/month

SUPPORT:
- 24/7 live chat support on all plans
- Onboarding and training call (Advanced and Professional)
- Priority support SLA (Professional only)
- 14-day free trial, no credit card required

PRICING (billed annually):
- Basic: $39/LinkedIn account/month — 1 active campaign, limited daily quotas (20/action/day)
- Advanced: $59/LinkedIn account/month — unlimited campaigns, full quotas (75 connections/day, 50 InMails/day), unified inbox, A/B testing, webhooks, CRM integrations
- Professional: $79/LinkedIn account/month — everything in Advanced plus team management, activity control, anti-duplication, priority support
- Enterprise: custom pricing — dedicated support, customer success manager, premium onboarding
- Monthly pricing (no annual discount): Basic $59, Advanced $79, Professional $99
- Email automation add-on: $15/email account/month
- Lead enrichment credits: 3000 credits for $43/month (1 email found = 3 credits, 225 free credits included)
- All plans include AI Appointment Setter

KEY STATS TO USE IN BLOGS:
- 4,100+ users
- Users average 55% reply rate
- 76% of free trials get their first lead within 2 days
- Users report 40%+ reply rates with voice note campaigns
- 110+ agencies on whitelabel program
- salesrobot.co is the official website
`;

// ════════════════════════════════════════════
// GET /api/webflow
// ════════════════════════════════════════════
app.get('/api/webflow', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(clientIp)) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });

    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !collectionId) return res.status(400).json({ error: 'Missing credentials' });

    if (itemId) {
      const r = await fetchWithTimeout(
        `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' } }, 15000, 2
      );
      const d = await r.json();
      return r.ok ? res.json(d) : res.status(r.status).json(d);
    }

    const cacheKey = collectionId;
    const cached = getFromCache(blogCache, cacheKey, BLOG_CACHE_TTL);
    if (cached) {
      console.log(`Serving ${cached.length} blogs from cache`);
      return res.json({ items: cached, cached: true, siteId: cached[0]?.siteId || null });
    }

    const items = await fetchAllBlogs(collectionId, token);
    setCache(blogCache, cacheKey, items);
    console.log(`Fetched and cached ${items.length} blogs`);
    res.json({ items, cached: false, siteId: items[0]?.siteId || null });
  } catch (err) {
    console.error('Webflow fetch error:', err);
    if (err.name === 'AbortError') return res.status(408).json({ error: 'Request timeout.', type: 'timeout' });
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// PATCH /api/webflow
// ════════════════════════════════════════════
app.patch('/api/webflow', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(clientIp)) return res.status(429).json({ error: 'Too many requests.' });

    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { fieldData } = req.body;
    if (!token || !collectionId || !itemId || !fieldData) return res.status(400).json({ error: 'Missing fields' });

    // server-side guarantee: lists always Webflow-safe regardless of frontend state
    if (fieldData && fieldData['post-body']) {
      fieldData['post-body'] = normalizeListsForWebflow(fieldData['post-body']);
    }

    const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ fieldData })
    }, 60000, 3);
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    blogCache.delete(collectionId);
    console.log('Published:', itemId);
    res.json(data);
  } catch (err) {
    console.error('Publish error:', err);
    if (err.name === 'AbortError') return res.status(408).json({ error: 'Publish timeout.', type: 'timeout' });
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// POST /api/upload-image
// ════════════════════════════════════════════
app.post('/api/upload-image', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' });
    if (file.size > 4 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 4MB)' });

    const base64 = file.buffer.toString('base64');
    const dataUri = `data:${file.mimetype};base64,${base64}`;
    console.log(`Image converted to base64: ${file.originalname} (${(file.size / 1024).toFixed(1)}KB)`);
    res.json({ url: dataUri });
  } catch (err) {
    console.error('Image upload error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large (max 4MB)' });
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// BRAVE SEARCH (with caching)
// ════════════════════════════════════════════
async function braveSearch(query, key, count = 5) {
  if (!key) return [];
  const cacheKey = `brave:${hashString(query + count)}`;
  const cached = getFromCache(searchResultsCache, cacheKey, SEARCH_CACHE_TTL);
  if (cached) { console.log(`  Brave cache hit: "${query}"`); return cached; }
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetchWithTimeout(url, { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } }, 10000, 2);
    if (!res.ok) { console.warn(`Brave search failed: ${res.status}`); return []; }
    const data = await res.json();
    const results = (data.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.description || '', source: 'brave' }));
    setCache(searchResultsCache, cacheKey, results);
    return results;
  } catch (err) { console.warn(`Brave search error: ${err.message}`); return []; }
}

// ════════════════════════════════════════════
// GOOGLE CUSTOM SEARCH (with caching)
// ════════════════════════════════════════════
async function googleSearch(query, key, cx, count = 5) {
  if (!key || !cx) return [];
  const cacheKey = `google:${hashString(query + count)}`;
  const cached = getFromCache(searchResultsCache, cacheKey, SEARCH_CACHE_TTL);
  if (cached) { console.log(`  Google cache hit: "${query}"`); return cached; }
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${count}`;
    const res = await fetchWithTimeout(url, {}, 10000, 2);
    if (!res.ok) { console.warn(`Google search failed: ${res.status}`); return []; }
    const data = await res.json();
    const results = (data.items || []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet || '', source: 'google' }));
    setCache(searchResultsCache, cacheKey, results);
    return results;
  } catch (err) { console.warn(`Google search error: ${err.message}`); return []; }
}

// ════════════════════════════════════════════
// POST /api/smartcheck — Research + Rewrite
// ════════════════════════════════════════════
app.post('/api/smartcheck', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(clientIp)) return res.status(429).json({ error: 'Too many analysis requests.' });

    const {
      blogContent, title, slug,
      anthropicKey, braveKey, googleKey, googleCx,
      gscKeywords, brandHints, addTldr
    } = req.body;

    if (!blogContent || !anthropicKey) return res.status(400).json({ error: 'Missing required fields' });

    // Check analysis cache
    const contentHash = hashString(blogContent + JSON.stringify(gscKeywords || []) + JSON.stringify(brandHints || []) + (addTldr ? 'tldr' : ''));
    const cachedAnalysis = getFromCache(analysisCache, contentHash, ANALYSIS_CACHE_TTL);
    if (cachedAnalysis) {
      console.log('Serving cached analysis');
      return res.json({ ...cachedAnalysis, fromCache: true });
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const t0 = Date.now();
    let searchCount = 0;

    // ── STEP 0: Protect widgets/embeds ──
    console.log('=== Stage 0: Widget Protection ===');
    const { protectedHtml: protectedContent, widgets } = protectWidgets(blogContent);
    console.log(`  Protected ${widgets.length} widgets/embeds`);
    widgets.forEach((w, i) => {
      const preview = w.content.substring(0, 100).replace(/\n/g, ' ').trim();
      console.log(`    Widget ${i}: ${preview}...`);
    });

    // ── 1. Fable audit (native web search) ──
    console.log('=== Stage 1: Fable Audit ===');
    const modelMode = req.body.modelMode || 'hybrid'; // 'hybrid' | 'fable' | 'sonnet'
    const audit = await fableAudit({
      anthropicKey, title,
      blogContent: protectedContent,
      brandHints, gscKeywords, modelMode
    });
    searchCount = audit.searchesUsed || 0;
    console.log(`  ${audit.findings?.length || 0} findings, ${searchCount} searches`);

    // ── 2. Rewrite from audit findings ──
    console.log('=== Stage 2: Rewrite ===');
    //const rewriteModel = modelMode === 'fable' ? 'claude-fable-5' : 'claude-sonnet-4-6';
    const rewriteModel = modelMode === 'fable' ? 'claude-opus-4-8' : 'claude-sonnet-4-6';

    const findingsBlock = (audit.findings || []).map((f, i) =>
      `${i + 1}. [${f.type.toUpperCase()}] in "${f.where}"
   FIND: ${f.current || '(addition — no existing text)'}
   ${f.current ? 'REPLACE WITH' : 'INSERT'}: ${f.corrected}
   WHY: ${f.reason}`
    ).join('\n\n');

    // ── TL;DR instruction ──
    let tldrTopInstruction = '';
    let tldrRule = '';
    if (addTldr) {
      tldrTopInstruction = `
CRITICAL FIRST TASK: This blog has NO TL;DR summary. Add one at the very beginning of your output:
<div class="tldr-box"><p><strong>TL;DR:</strong> [2-3 sentence summary of key takeaways. Be specific and actionable.]</p></div>

`;
      tldrRule = `
14. ADD a TL;DR box at the VERY TOP using: <div class="tldr-box"><p><strong>TL;DR:</strong> [summary]</p></div>`;
    }

    const rwRes = await Promise.race([
      anthropic.messages.create({
        model: rewriteModel,
        max_tokens: 32000,
        messages: [{ role: 'user', content: `You are a careful HTML editor for SalesRobot's blog. Apply ONLY the verified findings below to this blog. You are a typist executing verified edits — do not research, do not improvise, do not rewrite anything not listed.
${tldrTopInstruction}
TITLE: ${title}

CURRENT HTML:
${protectedContent}

VERIFIED FINDINGS TO APPLY (from a web-research audit):
${findingsBlock || '(no findings — return the HTML with only formatting rules applied)'}

ABSOLUTE RULES — violating any is a failure:
1. Return ONLY the updated HTML. No markdown fences. No explanation.
2. Apply each finding exactly: locate the FIND text, replace with the REPLACE text (or insert additions under the named heading). Keep replacement length similar to the original.
3. Change NOTHING else. Every other sentence stays byte-identical.
4. PRESERVE every HTML tag, class, id, data attribute EXACTLY as-is.
5. PRESERVE all heading levels and their attributes. Only heading TEXT may change if a finding targets it.
6. PRESERVE every <ul>, <ol>, <li> with ALL attributes. New lists MUST use: <ul role="list"><li role="listitem">text</li></ul>
7. PRESERVE every <a>, <img>, <strong>, <em> with all attributes.
8. PRESERVE every placeholder like ___WIDGET_0___, ___WIDGET_1___ EXACTLY — never modify, move, escape, or delete them.
9. New bold = <strong>, new italic = <em>. Never markdown syntax anywhere.
10. Never convert HTML to markdown.
11. Never remove existing SalesRobot content — only add or correct per findings.
12. Use active voice in new text. Use contractions where natural.
13. Insert additions as complete, well-formed HTML blocks (<p>, <ul role="list">) under their target heading.${tldrRule}` }]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Content rewrite timeout')), 300000))
    ]);

    let updated = rwRes.content[0].text;
    if (updated.startsWith('```')) updated = updated.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
    updated = updated.trim();

    // ── STEP 3: Restore widgets (tolerant + anchor recovery) ──
    console.log('=== Stage 3: Widget Restoration ===');
    const { restored, warnings: widgetWarnings } = restoreWidgets(updated, widgets);
    updated = restored;
    console.log(`  Restored ${widgets.length} widgets (${widgetWarnings.length} warnings)`);

    // ── STEP 3.5: Normalize lists for Webflow (server-side guarantee) ──
    updated = normalizeListsForWebflow(updated);

    // ── Content safety check ──
    const stripTags = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const originalLen = stripTags(blogContent).length;
    const updatedLen = stripTags(updated).length;
    const ratio = updatedLen / Math.max(originalLen, 1);
    console.log(`  Content check: original ${originalLen} chars → updated ${updatedLen} chars (${(ratio * 100).toFixed(0)}%)`);

    let contentWarning = null;
    if (ratio < 0.5 && originalLen > 500) {
      contentWarning = `Updated content is only ${(ratio * 100).toFixed(0)}% of original length. Some content may have been lost — please review carefully.`;
      console.warn(`  ⚠ ${contentWarning}`);
    }

    const tldrAdded = addTldr && (updated.toLowerCase().includes('tl;dr') || updated.includes('tldr-box'));

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Done in ${elapsed}s`);

    const result = {
      updatedContent: updated,
      changelog: (audit.findings || []).map(f => ({
        type: f.type, where: f.where, reason: f.reason,
        from: f.current ? f.current.slice(0, 160) : null,
        to: f.corrected ? f.corrected.slice(0, 160) : null
      })),
      verified: audit.verified || [],
      widgetWarnings,
      stats: {
        searches: searchCount,
        findings: audit.findings?.length || 0,
        elapsed,
        modelMode,
        gscKeywords: gscKeywords?.length || 0,
        widgetsProtected: widgets.length
      },
      tldrAdded,
      contentWarning
    };

    setCache(analysisCache, contentHash, result);
    res.json(result);
  } catch (err) {
    console.error('Smart check error:', err);
    if (err.message.includes('timeout')) {
      return res.status(408).json({ error: 'Analysis timeout. Try a shorter blog.', type: 'timeout' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// HEALTH & STATS
// ════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    caches: { blogs: blogCache.size, searchResults: searchResultsCache.size, analyses: analysisCache.size },
    rateLimits: { activeIPs: rateLimitMap.size }
  });
});

app.get('/api/debug', (req, res) => {
  const blogData = Array.from(blogCache.values())[0];
  res.json({
    hasBlogCache: blogCache.size > 0,
    sampleBlogHasSiteId: blogData?.data?.[0]?.siteId ? true : false,
    sampleSiteId: blogData?.data?.[0]?.siteId || 'not found'
  });
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
