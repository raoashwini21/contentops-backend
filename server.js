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
// WIDGET PROTECTION
// ════════════════════════════════════════════
function protectWidgets(html) {
  const widgets = [];
  const protectedHtml = html.replace(
    /(<(?:iframe|script|embed|object)[^>]*>(?:[\s\S]*?<\/(?:iframe|script|embed|object)>)?)|(<div[^>]*class="[^"]*(?:w-embed|w-widget|widget|embed)[^"]*"[^>]*>[\s\S]*?<\/div>)|(<figure[^>]*>[\s\S]*?<\/figure>)|(<video[^>]*>[\s\S]*?<\/video>)/gi,
    (match) => {
      const id = `___WIDGET_${widgets.length}___`;
      widgets.push(match);
      return id;
    }
  );
  return { protectedHtml, widgets };
}

function restoreWidgets(html, widgets) {
  let restored = html;
  widgets.forEach((widget, i) => {
    restored = restored.replace(`___WIDGET_${i}___`, widget);
  });
  return restored;
}

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
// POST /api/upload-image — Accepts multipart/form-data
// Fixed: uses multer to parse the file from browser FormData
// ════════════════════════════════════════════
// ════════════════════════════════════════════
// POST /api/upload-image — Simple passthrough
// Images are inserted directly as base64 or URL into the blog HTML.
// No Webflow Assets API needed (matches working v1 approach).
// ════════════════════════════════════════════
app.post('/api/upload-image', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' });
    if (file.size > 4 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 4MB)' });

    // Convert to base64 data URI — inserted directly into HTML
    const base64 = file.buffer.toString('base64');
    const dataUri = `data:${file.mimetype};base64,${base64}`;

    console.log(`📸 Image converted to base64: ${file.originalname} (${(file.size / 1024).toFixed(1)}KB)`);

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
// Now supports: brandHints, addTldr
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

    // ── 1. Generate search queries ──
    console.log('=== Stage 1: Query Gen ===');

    // Build brand-aware query generation prompt
    let brandQueryHint = '';
    if (brandHints && brandHints.length > 0) {
      brandQueryHint = `\n\nIMPORTANT CONTEXT:\n${brandHints.join('\n')}\nMake sure search queries target the CORRECT product/brand. For example, if the blog is about Copilot.ai (sales tool), search for "copilot.ai pricing" NOT "microsoft copilot pricing".`;
    }

    const qRes = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: `Generate 6-8 search queries to fact-check: "${title}"

BLOG EXCERPT:
${protectedContent.substring(0, 4000)}
${brandQueryHint}

Return ONLY a JSON array of strings. Focus on:
- Official pricing pages (site:company.com pricing)
- Product feature updates (product 2025 features)
- Stats and claims verification
- Competitor info mentioned
Include year 2025/2026 for latest info.` }]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Query generation timeout')), 30000))
    ]);

    let queries = [];
    try {
      const raw = qRes.content[0].text.replace(/```json\n?|```\n?/g, '').trim();
      queries = JSON.parse(raw);
    } catch {
      const m = qRes.content[0].text.match(/\[[\s\S]*?\]/);
      queries = m ? JSON.parse(m[0]) : [];
    }
    console.log(`  ${queries.length} queries generated`);

    // ── 2. Run searches ──
    console.log('=== Stage 2: Search ===');
    let allResults = [];
    const batchSize = 3;
    for (let i = 0; i < queries.length && i < 8; i += batchSize) {
      const batch = queries.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async q => {
          const [b, g] = await Promise.all([
            braveSearch(q, braveKey, 3),
            googleSearch(q, googleKey, googleCx, 3)
          ]);
          searchCount++;
          return { query: q, results: [...b, ...g] };
        })
      );
      allResults.push(...batchResults);
      if (i + batchSize < Math.min(queries.length, 8)) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const seen = new Set();
    const unique = [];
    for (const grp of allResults) {
      for (const r of grp.results) {
        if (!seen.has(r.url)) { seen.add(r.url); unique.push({ ...r, query: grp.query }); }
      }
    }
    console.log(`  ${unique.length} unique results from ${searchCount} searches`);

    // ── 3. Claude rewrite ──
    console.log('=== Stage 3: Rewrite ===');

    const research = unique.map(r =>
      `[${r.source?.toUpperCase()}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
    ).join('\n\n');

    let gscBlock = '';
    if (gscKeywords?.length > 0) {
      gscBlock = `

GSC KEYWORDS TO INTEGRATE:
${gscKeywords.map(k => `- "${k.keyword}" (Pos ${k.position}, ${k.clicks} clicks)`).join('\n')}

GSC RULES:
- Work keywords into EXISTING H2/H3 headings where natural
- Add a short paragraph for keywords with no existing coverage
- For question keywords (who/what/how/why/is/can/does), add an FAQ at bottom
- Do NOT keyword-stuff`;
    }

    // Brand disambiguation block for Claude rewrite
    let brandBlock = '';
    if (brandHints && brandHints.length > 0) {
      brandBlock = `

CRITICAL — BRAND DISAMBIGUATION:
${brandHints.join('\n')}
READ THE ENTIRE BLOG FIRST to understand which product is being discussed. Only use research results that match the correct brand/product. Discard any search results about the wrong product.`;
    }

    // TL;DR instruction — injected at TOP of prompt and as a rule
    let tldrTopInstruction = '';
    let tldrRule = '';
    if (addTldr) {
      tldrTopInstruction = `
CRITICAL FIRST TASK: This blog has NO TL;DR summary. You MUST add one at the very beginning of your output (before any other content). Use this exact format:
<div class="tldr-box"><p><strong>TL;DR:</strong> [2-3 sentence summary of key takeaways. Be specific and actionable.]</p></div>

`;
      tldrRule = `
16. ADD a TL;DR box at the VERY TOP of the output using: <div class="tldr-box"><p><strong>TL;DR:</strong> [summary]</p></div>`;
    }

    const rwRes = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        messages: [{ role: 'user', content: `You are an expert blog content updater. Rewrite this blog using the research below.
${tldrTopInstruction}
TITLE: ${title}

CURRENT HTML:
${protectedContent}

RESEARCH:
${research}
${gscBlock}${brandBlock}

ABSOLUTE RULES — violating any is a failure:
1. Return ONLY the updated HTML. No markdown fences. No explanation.
2. PRESERVE every HTML tag, class, id, data attribute EXACTLY as-is unless fixing a fact.
3. PRESERVE all heading levels (h1-h6). Only change heading TEXT for GSC keywords or factual fixes.
4. PRESERVE every <ul>, <ol>, <li> with ALL attributes (role, class, style, etc).
5. PRESERVE every <strong>, <em>, <b>, <i> tag.
6. PRESERVE every <a> with href, target, rel attributes.
7. PRESERVE every <img> with src, alt, loading, width, height, class, style attributes.
8. PRESERVE every placeholder like ___WIDGET_0___, ___WIDGET_1___ etc.
9. Fix outdated facts (pricing, features, stats) using research data.
10. New lists MUST use: <ul role="list"><li role="listitem">text</li></ul>
11. New bold = <strong>, new italic = <em>. Never markdown.
12. Use active voice. Remove em-dashes. Use contractions where natural.
13. NEVER strip attributes from any existing element.
14. NEVER convert HTML to markdown.
15. DO NOT remove or modify any ___WIDGET_N___ markers.${tldrRule}` }]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Content rewrite timeout')), 300000))
    ]);

    let updated = rwRes.content[0].text;
    if (updated.startsWith('```')) updated = updated.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
    updated = updated.trim();

    // ── STEP 4: Restore widgets ──
    console.log('=== Stage 4: Widget Restoration ===');
    updated = restoreWidgets(updated, widgets);
    console.log(`  Restored ${widgets.length} widgets`);

    // Check if TL;DR was actually added
    const tldrAdded = addTldr && (updated.toLowerCase().includes('tl;dr') || updated.includes('tldr-box'));

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Done in ${elapsed}s`);

    const result = {
      updatedContent: updated,
      stats: {
        searches: searchCount,
        results: unique.length,
        elapsed,
        gscKeywords: gscKeywords?.length || 0,
        widgetsProtected: widgets.length
      },
      research: unique.slice(0, 15),
      tldrAdded
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
