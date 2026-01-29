import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

// ============================================
// GOOGLE CUSTOM SEARCH API
// ============================================
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID || '90a56bfbc96304c89';

if (!GOOGLE_API_KEY) {
  console.error('⚠️ WARNING: GOOGLE_API_KEY not found in environment variables!');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const writingSystemPrompt = `You are an expert blog editor. You:
1. Preserve ALL HTML structure, tags, classes, IDs exactly
2. Preserve ALL heading levels (H1-H6) exactly - never change hierarchy
3. Preserve ALL links with href, target, rel attributes exactly
4. Preserve ALL images, iframes, embeds, widgets, scripts exactly
5. Preserve ALL paragraph breaks, lists, tables exactly
6. Fix factual errors based on research
7. Remove em-dashes, shorten sentences, use contractions
8. Use active voice
9. Return ONLY HTML, no markdown`;

// ============================================
// BACKEND BLOG CACHE (Solves Concurrent User Issues)
// ============================================
let blogCache = {
  data: null,
  timestamp: null,
  collectionId: null,
  isRefreshing: false
};

const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const BACKGROUND_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

// Fetch all blogs from Webflow
async function fetchAllBlogsFromWebflow(collectionId, webflowToken) {
  console.log('📥 Fetching all blogs from Webflow...');
  const startTime = Date.now();
  
  const allItems = [];
  const limit = 100;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?limit=${limit}&offset=${offset}`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${webflowToken}`,
        'accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Webflow API error: ${response.status}`);
    }

    const data = await response.json();
    const items = data.items || [];

    console.log(`  Batch: offset=${offset}, received=${items.length} items`);

    allItems.push(...items);

    if (items.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  // DEDUPLICATE by ID (in case Webflow API returns duplicates)
  const uniqueItems = [];
  const seenIds = new Set();
  
  for (const item of allItems) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      uniqueItems.push(item);
    }
  }

  const duplicatesRemoved = allItems.length - uniqueItems.length;
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Fetched ${allItems.length} blogs from Webflow in ${duration}s`);
  if (duplicatesRemoved > 0) {
    console.log(`⚠️ Removed ${duplicatesRemoved} duplicates → ${uniqueItems.length} unique blogs`);
  } else {
    console.log(`✓ All ${uniqueItems.length} blogs are unique (no duplicates)`);
  }

  return { items: uniqueItems };
}

// Check if cache is valid
function isCacheValid(collectionId) {
  if (!blogCache.data) return false;
  if (blogCache.collectionId !== collectionId) return false;
  if (!blogCache.timestamp) return false;
  
  const age = Date.now() - blogCache.timestamp;
  return age < CACHE_DURATION;
}

// Background refresh (optional - keeps cache warm)
async function backgroundRefreshCache(collectionId, webflowToken) {
  if (blogCache.isRefreshing) {
    console.log('⏭️ Skipping background refresh - already in progress');
    return;
  }

  blogCache.isRefreshing = true;
  
  try {
    console.log('🔄 Background cache refresh starting...');
    const freshData = await fetchAllBlogsFromWebflow(collectionId, webflowToken);
    
    blogCache.data = freshData;
    blogCache.timestamp = Date.now();
    blogCache.collectionId = collectionId;
    
    console.log('✅ Background cache refresh complete');
  } catch (error) {
    console.error('❌ Background cache refresh failed:', error.message);
  } finally {
    blogCache.isRefreshing = false;
  }
}

// ============================================
// CACHED WEBFLOW API PROXY
// ============================================
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId, limit, offset } = req.query;
    const webflowToken = req.headers.authorization?.replace('Bearer ', '');

    if (!webflowToken || !collectionId) {
      return res.status(400).json({ error: 'Missing Webflow token or collection ID' });
    }

    // Single item fetch (not cached)
    if (itemId) {
      console.log(`📄 Fetching single item: ${itemId}`);
      const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${webflowToken}`,
          'accept': 'application/json'
        }
      });

      const data = await response.json();
      
      if (!response.ok) {
        return res.status(response.status).json(data);
      }

      return res.json(data);
    }

    // List fetch - USE CACHE
    console.log('📋 Blog list request received');

    // Check if cache is valid
    if (isCacheValid(collectionId)) {
      const cacheAge = Math.round((Date.now() - blogCache.timestamp) / 1000);
      console.log(`✅ Cache HIT! Serving ${blogCache.data.items.length} blogs (age: ${cacheAge}s)`);
      
      // Add cache headers
      res.set('X-Cache', 'HIT');
      res.set('X-Cache-Age', cacheAge.toString());
      
      // OPTIMIZATION: When serving from cache, return ALL blogs at once (no pagination)
      // This prevents frontend from making multiple paginated requests
      // Frontend pagination (limit/offset) only applies to fresh Webflow fetches
      return res.json(blogCache.data);
    }

    // Cache miss or expired - fetch fresh data
    const cacheStatus = !blogCache.data ? 'EMPTY' : 'EXPIRED';
    console.log(`❌ Cache ${cacheStatus} - fetching from Webflow...`);

    // Prevent multiple concurrent fetches
    if (blogCache.isRefreshing) {
      console.log('⏳ Waiting for ongoing refresh...');
      // Wait up to 3 minutes for the refresh to complete
      const maxWait = 180000; // 3 minutes
      const waitStart = Date.now();
      
      while (blogCache.isRefreshing && (Date.now() - waitStart) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (isCacheValid(collectionId)) {
        console.log('✅ Cache populated by concurrent request');
        res.set('X-Cache', 'WAIT-HIT');
        return res.json(blogCache.data);
      }
    }

    blogCache.isRefreshing = true;

    try {
      const freshData = await fetchAllBlogsFromWebflow(collectionId, webflowToken);
      
      // Update cache
      blogCache.data = freshData;
      blogCache.timestamp = Date.now();
      blogCache.collectionId = collectionId;
      
      res.set('X-Cache', 'MISS');
      res.set('X-Cache-Age', '0');
      
      res.json(freshData);
    } finally {
      blogCache.isRefreshing = false;
    }

  } catch (error) {
    console.error('Webflow API error:', error);
    blogCache.isRefreshing = false;
    res.status(500).json({ error: error.message });
  }
});

// Cache status endpoint (for debugging)
app.get('/api/cache-status', (req, res) => {
  const cacheAge = blogCache.timestamp ? Math.round((Date.now() - blogCache.timestamp) / 1000) : null;
  const isValid = isCacheValid(blogCache.collectionId);
  
  res.json({
    hasCachedData: !!blogCache.data,
    itemCount: blogCache.data?.items?.length || 0,
    cacheAgeSeconds: cacheAge,
    isValid: isValid,
    collectionId: blogCache.collectionId,
    isRefreshing: blogCache.isRefreshing,
    cacheDurationSeconds: CACHE_DURATION / 1000
  });
});

// Force cache clear (for debugging)
app.post('/api/cache-clear', (req, res) => {
  console.log('🗑️ Cache manually cleared');
  blogCache.data = null;
  blogCache.timestamp = null;
  blogCache.collectionId = null;
  res.json({ success: true, message: 'Cache cleared' });
});

// ============================================
// WEBFLOW UPDATE (No caching needed)
// ============================================
app.patch('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const webflowToken = req.headers.authorization?.replace('Bearer ', '');
    const { fieldData } = req.body;

    if (!webflowToken || !collectionId || !itemId || !fieldData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`📝 Updating item ${itemId}...`);

    const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
    
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${webflowToken}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({ fieldData })
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('Webflow PATCH error:', data);
      return res.status(response.status).json(data);
    }

    console.log('✅ Item updated successfully');
    
    // Invalidate cache after update so next fetch gets fresh data
    if (blogCache.collectionId === collectionId) {
      console.log('🔄 Cache invalidated due to item update');
      blogCache.timestamp = 0; // Force refresh on next request
    }

    res.json(data);
  } catch (error) {
    console.error('Webflow update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SMART ANALYSIS ENDPOINT (HYBRID SEARCH)
// ============================================
app.post('/api/analyze', async (req, res) => {
  try {
    const { 
      blogContent, 
      title, 
      anthropicKey, 
      braveKey,
      researchPrompt,
      writingPrompt
    } = req.body;

    if (!blogContent || !anthropicKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    
    let totalSearchesUsed = 0;
    let totalClaudeCalls = 0;
    let allChanges = [];

    const startTime = Date.now();

    // ============================================
    // STAGE 1: QUERY GENERATION
    // ============================================
    console.log('=== STAGE 1: QUERY GENERATION ===');
    
    const queryPrompt = `Generate 6-8 search queries to fact-check this blog: "${title}"

BLOG EXCERPT:
${blogContent.substring(0, 3000)}

RULES:
1. Use "site:companyname.com" for official sources
2. Search for "new features 2025", "ai features 2025"
3. Target specific products/tools mentioned
4. DO NOT generate pricing queries (manual verification)
5. Include year "2025" for latest info

🤖 SPECIAL: If SalesRobot mentioned, ALWAYS include:
- "site:salesrobot.co ai features 2025"
- "salesrobot ai capabilities 2025"
- "salesrobot ai message optimization"

GOOD: "site:mailshake.com features 2025", "mailshake ai features 2025"
BAD: "mailshake pricing", "best email tools"

Return JSON array: ["query1", "query2", ...]`;

    const queryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: queryPrompt }]
    });

    totalClaudeCalls++;

    let searchQueries = [];
    try {
      const queryText = queryResponse.content[0].text.trim()
        .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      searchQueries = JSON.parse(queryText);
      console.log('✓ Generated queries:');
      searchQueries.forEach((q, i) => {
        const isPricing = q.toLowerCase().includes('pric');
        console.log(`  ${i + 1}. ${q} ${isPricing ? '⚠️ PRICING' : '✓'}`);
      });
    } catch (e) {
      console.error('Query parse failed:', e);
      searchQueries = [];
    }

    if (searchQueries.length === 0) {
      return res.status(400).json({ error: 'Failed to generate queries' });
    }

    // ============================================
    // STAGE 2: HYBRID SEARCH (BRAVE + GOOGLE)
    // ============================================
    console.log('\n=== STAGE 2: HYBRID SEARCH ===');
    
    // Separate queries by type
    const pricingQueries = [];
    const featureQueries = [];
    
    searchQueries.slice(0, 8).forEach(q => {
      const isPricing = q.toLowerCase().includes('pric') || 
                       q.toLowerCase().includes('cost') ||
                       q.toLowerCase().includes('plan');
      if (isPricing) {
        pricingQueries.push(q);
      } else {
        featureQueries.push(q);
      }
    });
    
    console.log(`Distribution: ${featureQueries.length} Brave + ${pricingQueries.length} Google`);
    
    let findings = `# HYBRID SEARCH FINDINGS\n\n`;

    // PART A: BRAVE SEARCH (Features)
    if (featureQueries.length > 0 && braveKey) {
      console.log('\n--- BRAVE SEARCH (Features) ---');
      
      for (const query of featureQueries) {
        try {
          console.log(`Brave ${totalSearchesUsed + 1}: ${query}`);
          
          const braveResponse = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
            {
              headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': braveKey
              }
            }
          );

          if (braveResponse.ok) {
            const braveData = await braveResponse.json();
            totalSearchesUsed++;
            
            findings += `## "${query}" [BRAVE]\n`;
            
            if (braveData.web?.results) {
              braveData.web.results.slice(0, 3).forEach((r, i) => {
                findings += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ''}\n\n`;
                console.log(`  ${i + 1}. ${r.title.substring(0, 60)}...`);
              });
            }
            findings += '\n';
          } else {
            console.error(`Brave error: ${braveResponse.status}`);
          }
          
          await new Promise(r => setTimeout(r, 400));
          
        } catch (error) {
          console.error(`Brave failed: ${error.message}`);
        }
      }
    }

    // PART B: GOOGLE SEARCH (Pricing)
    if (pricingQueries.length > 0 && GOOGLE_API_KEY) {
      console.log('\n--- GOOGLE SEARCH (Pricing) ---');
      
      for (const query of pricingQueries) {
        try {
          console.log(`Google ${totalSearchesUsed + 1}: ${query}`);
          
          const googleResponse = await fetch(
            `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=5`,
            { headers: { 'Accept': 'application/json' } }
          );

          if (googleResponse.ok) {
            const googleData = await googleResponse.json();
            totalSearchesUsed++;
            
            findings += `## "${query}" [GOOGLE-PRICING]\n`;
            
            if (googleData.items) {
              googleData.items.slice(0, 3).forEach((r, i) => {
                findings += `${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.snippet || ''}\n\n`;
                console.log(`  ${i + 1}. ${r.title.substring(0, 60)}...`);
              });
            }
            findings += '\n';
          } else {
            const err = await googleResponse.json();
            console.error(`Google error: ${err.error?.message || googleResponse.status}`);
          }
          
          await new Promise(r => setTimeout(r, 200));
          
        } catch (error) {
          console.error(`Google failed: ${error.message}`);
        }
      }
    }

    console.log(`\n✓ Search complete: ${totalSearchesUsed} total`);

    // ============================================
    // STAGE 3: CONTENT REWRITING
    // ============================================
    console.log('\n=== STAGE 3: CONTENT REWRITING ===');

    const MAX_CHUNK = 15000;
    let chunks = [];
    
    if (blogContent.length > MAX_CHUNK) {
      console.log(`Chunking ${blogContent.length} chars...`);
      const sections = blogContent.split(/(<h[1-6][^>]*>.*?<\/h[1-6]>)/gi);
      let current = '';
      
      for (const section of sections) {
        if (current.length + section.length > MAX_CHUNK && current.length > 0) {
          chunks.push(current);
          current = section;
        } else {
          current += section;
        }
      }
      
      if (current) chunks.push(current);
      console.log(`Split into ${chunks.length} chunks`);
    } else {
      chunks = [blogContent];
    }

    let finalContent = '';
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      console.log(`Processing chunk ${i + 1}/${chunks.length}...`);

      const rewritePrompt = `Rewrite based on search findings.

SEARCH RESULTS:
${findings}

CONTENT:
${chunk}

RULES:
⚠️ NEVER update pricing (manual verification only)
✅ Add NEW features from official sources
✅ Add AI features if found
✅ Update stats from authoritative sources
✅ Preserve ALL HTML structure exactly
✅ Keep heading levels exact (H1-H6)
✅ Keep all links, images, widgets exact

🤖 SALESROBOT: If mentioned, ADD AI features found:
- AI message optimization
- AI subject lines
- AI personalization
- Smart automation
Add naturally with "Additionally," or "Moreover,"

Return ONLY rewritten HTML, no explanations.`;

      const rewriteResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        system: writingSystemPrompt,
        messages: [{ role: 'user', content: rewritePrompt }]
      });

      totalClaudeCalls++;
      finalContent += rewriteResponse.content[0].text.trim();
      
      console.log(`✓ Chunk ${i + 1} complete`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`\n✅ COMPLETE: ${duration}s | ${totalSearchesUsed} searches | ${totalClaudeCalls} Claude calls\n`);

    res.json({
      content: finalContent,
      changes: allChanges,
      searchesUsed: totalSearchesUsed,
      claudeCalls: totalClaudeCalls,
      sectionsUpdated: chunks.length,
      duration: parseFloat(duration)
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 ContentOps backend: port ${PORT}`);
  console.log(`🔍 Google Search: ${GOOGLE_API_KEY ? '✓' : '✗ (pricing skipped)'}`);
  console.log(`💾 Blog cache: Enabled (${CACHE_DURATION / 1000}s TTL)`);
});
