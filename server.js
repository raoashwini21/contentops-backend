import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

// ============================================
// GOOGLE CUSTOM SEARCH API (Backend Environment Variables)
// ============================================
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID || '90a56bfbc96304c89';

// Verify keys loaded
if (!GOOGLE_API_KEY) {
  console.error('⚠️ WARNING: GOOGLE_API_KEY not found in environment variables!');
  console.error('   Pricing verification will be skipped.');
  console.error('   Set GOOGLE_API_KEY in Railway dashboard > Variables tab');
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
// WEBFLOW API PROXY
// ============================================
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId, limit = 100, offset = 0 } = req.query;
    const webflowToken = req.headers.authorization?.replace('Bearer ', '');

    if (!webflowToken || !collectionId) {
      return res.status(400).json({ error: 'Missing Webflow token or collection ID' });
    }

    let url;
    if (itemId) {
      url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
    } else {
      url = `https://api.webflow.com/v2/collections/${collectionId}/items?limit=${limit}&offset=${offset}`;
    }

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

    res.json(data);
  } catch (error) {
    console.error('Webflow API error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const webflowToken = req.headers.authorization?.replace('Bearer ', '');
    const { fieldData } = req.body;

    if (!webflowToken || !collectionId || !itemId || !fieldData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

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
});
