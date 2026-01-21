import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ContentOps Backend Running', version: '3.0-FINAL' });
});

// Webflow proxy with pagination
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId, offset = '0', limit = '100' } = req.query;
    const authHeader = req.headers.authorization;

    if (!collectionId || !authHeader) {
      return res.status(400).json({ error: 'Missing collectionId or authorization' });
    }

    // Single item fetch (for testing connection)
    if (itemId) {
      const response = await fetch(
        `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
        {
          headers: {
            'Authorization': authHeader,
            'accept': 'application/json'
          }
        }
      );

      const data = await response.json();
      
      if (!response.ok) {
        return res.status(response.status).json({ 
          error: data.message || data.err || 'Webflow API error',
          details: data
        });
      }
      
      return res.json(data);
    }

    // List items with pagination
    const response = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=${limit}`,
      {
        headers: {
          'Authorization': authHeader,
          'accept': 'application/json'
        }
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ 
        error: data.message || data.err || 'Webflow API error',
        details: data
      });
    }
    
    res.json(data);
  } catch (error) {
    console.error('Webflow proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webflow update (PATCH)
app.patch('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const authHeader = req.headers.authorization;
    const { fieldData } = req.body;

    if (!collectionId || !itemId || !authHeader) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    console.log('Updating Webflow item:', itemId);
    console.log('Payload size:', JSON.stringify(fieldData).length, 'characters');

    const response = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'accept': 'application/json'
        },
        body: JSON.stringify({ fieldData })
      }
    );

    const data = await response.json();
    console.log('Webflow response status:', response.status);
    
    if (!response.ok) {
      console.error('Webflow error:', data);
      return res.status(response.status).json({ 
        error: data.message || data.err || `Webflow API error: ${response.statusText}`,
        details: data,
        statusCode: response.status
      });
    }
    
    res.json(data);
  } catch (error) {
    console.error('Webflow update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to split blog into manageable chunks
const splitBlogIntoChunks = (content, maxChunkSize = 10000) => {
  if (content.length <= maxChunkSize) return [content];
  
  const chunks = [];
  let currentChunk = '';
  const paragraphs = content.split(/<\/p>|<\/h[1-6]>|<\/li>/);
  
  for (const para of paragraphs) {
    const fullPara = para + (para.includes('<p') ? '</p>' : para.includes('<h') ? `</h${para.match(/<h([1-6])/)?.[1] || '2'}>` : '</li>');
    
    if ((currentChunk + fullPara).length > maxChunkSize && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = fullPara;
    } else {
      currentChunk += fullPara;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
};

// Main analysis endpoint
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

    if (!blogContent || !anthropicKey || !braveKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    
    let totalSearchesUsed = 0;
    let totalClaudeCalls = 0;
    let allChanges = [];

    console.log('Starting chunked analysis for:', title);
    console.log('Blog size:', blogContent.length, 'characters');

    // Determine if blog needs chunking (over 10,000 chars = chunk it)
    const needsChunking = blogContent.length > 10000;
    const chunks = needsChunking ? splitBlogIntoChunks(blogContent, 10000) : [blogContent];
    
    console.log(`Processing in ${chunks.length} chunk(s)`);

    // STAGE 1: Generate search queries (once for entire blog)
    console.log('Stage 1: Generate search queries...');
    console.log('%c=== QUERY GENERATION ===', 'background: #8b5cf6; color: white; padding: 4px 8px; font-weight: bold;');
    console.log('Blog title:', title);
    console.log('Research type:', researchPrompt ? 'Custom' : 'Default');
    
    const queryGenerationPrompt = `Analyze this blog post and generate 6-8 HIGHLY SPECIFIC search queries for fact-checking.

RESEARCH INSTRUCTIONS:
${researchPrompt || 'Verify all claims, pricing, features, and statistics mentioned.'}

BLOG TITLE: ${title}

BLOG CONTENT (first 3000 chars):
${blogContent.substring(0, 3000)}

CRITICAL SEARCH QUERY RULES:
1. For FEATURES: Search for BOTH current AND new features:
   - "site:companyname.com features 2025"
   - "companyname new features 2025"
   - "companyname ai features 2025" (if AI product)
   - "companyname recent updates 2025"
2. For STATISTICS: Use "companyname official statistics 2025" or authoritative sources
3. For LIMITS/QUOTAS: Use "site:companyname.com limits" or "companyname official documentation limits"
4. For COMPARISONS: Search official sources of BOTH products being compared
5. ALWAYS prefer official sources: Use "site:" operator or include "official" keyword
6. Include year "2025" for LATEST information
7. DO NOT generate pricing queries (pricing will be manually verified)

Generate search queries that will help verify:
- Features - BOTH current AND new (Search: "features 2025" AND "new features 2025" AND "ai features 2025")
- NEW integrations and capabilities (Search: "companyname recent updates 2025", "new integrations")
- Statistics (Use official company reports or authoritative sources)
- Platform limits/quotas (Use: "site:companyname.com limits" or official docs)
- Technical specifications (Use: "site:companyname.com documentation" or official specs)

EXAMPLE GOOD QUERIES (focus on features, NOT pricing):
✅ "site:mailshake.com features 2025"
✅ "mailshake new features 2025"
✅ "mailshake ai features 2025"
✅ "salesrobot new capabilities 2025"
✅ "salesrobot recent updates january 2025"
✅ "site:linkedin.com connection limits official 2025"
✅ "email deliverability statistics official 2024"

EXAMPLE BAD QUERIES (don't generate these):
❌ "mailshake pricing" (pricing verified manually)
❌ "best email tools" (not specific)
❌ "email automation features" (too generic, misses NEW features)

Return ONLY a JSON array of 6-8 search query strings. Example:
["site:mailshake.com features 2025", "mailshake new features 2025", "mailshake ai capabilities 2025"]

Focus on entities actually mentioned in this blog. Prioritize official sources. DO NOT include pricing queries.`;

    const queryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: queryGenerationPrompt }]
    });

    totalClaudeCalls++;

    let searchQueries = [];
    try {
      const queryText = queryResponse.content[0].text.trim()
        .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      searchQueries = JSON.parse(queryText);
      console.log('%c✓ Generated search queries:', 'color: #10b981; font-weight: bold;');
      searchQueries.forEach((q, i) => {
        const isOfficialSource = q.includes('site:') || q.includes('official');
        const isPricing = q.toLowerCase().includes('pricing') || q.toLowerCase().includes('price') || q.toLowerCase().includes('cost');
        if (isPricing) {
          console.log(`  ${i + 1}. ${q} ⚠️ (PRICING - will be skipped)`);
        } else {
          console.log(`  ${i + 1}. ${q} ${isOfficialSource ? '🔒 (official source)' : '⚠️ (generic)'}`);
        }
      });
      
      // Filter out any pricing queries
      searchQueries = searchQueries.filter(q => {
        const isPricing = q.toLowerCase().includes('pricing') || q.toLowerCase().includes('price') || q.toLowerCase().includes('cost');
        if (isPricing) {
          console.log(`%c⏭️ Skipping pricing query: ${q}`, 'color: #f59e0b;');
        }
        return !isPricing;
      });
    } catch (error) {
      console.error('%cFailed to parse queries:', 'color: #ef4444;', error);
      searchQueries = [`${title} features 2025`, `${title} new features`, 'industry statistics 2025'];
      console.log('Using fallback queries:', searchQueries);
    }

    // STAGE 2: Brave Search (once for entire blog)
    console.log('Stage 2: Brave Search...');
    console.log('%c=== BRAVE SEARCH STARTING ===', 'background: #0ea5e9; color: white; padding: 4px 8px; font-weight: bold;');
    
    let researchFindings = `# BRAVE SEARCH FINDINGS

⚠️ IMPORTANT VERIFICATION NOTE:
- Multiple searches help cross-verify features and facts
- Look for dates/timestamps in search results
- Prefer results from 2025 > 2024 > 2023
- Focus on NEW features, integrations, and capabilities not in original blog
- If results conflict or unclear: KEEP ORIGINAL TEXT

`;

    for (const query of searchQueries.slice(0, 8)) {
      try {
        console.log(`%cBrave Search ${totalSearchesUsed + 1}: ${query}`, 'color: #0ea5e9; font-weight: bold;');
        
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
          
          researchFindings += `## Query: "${query}"\n`;
          
          console.log('%cSearch Results:', 'color: #10b981; font-weight: bold;');
          
          if (braveData.web?.results) {
            braveData.web.results.slice(0, 3).forEach((result, i) => {
              researchFindings += `${i + 1}. **${result.title}**\n`;
              researchFindings += `   URL: ${result.url}\n`;
              researchFindings += `   ${result.description || ''}\n\n`;
              
              // LOG TO CONSOLE
              console.log(`  ${i + 1}. ${result.title}`);
              console.log(`     ${result.url}`);
              console.log(`     ${result.description?.substring(0, 150) || '(no description)'}...`);
            });
          } else {
            console.log('%c  No results found', 'color: #f59e0b;');
          }
          researchFindings += '\n';
        } else {
          console.error('%cBrave API Error:', 'color: #ef4444; font-weight: bold;', braveResponse.status);
        }
        
        await new Promise(resolve => setTimeout(resolve, 400)); // Rate limit
        
      } catch (error) {
        console.error(`%cBrave search failed for "${query}":`, 'color: #ef4444;', error.message);
      }
    }

    console.log('%c=== BRAVE SEARCH COMPLETE ===', 'background: #10b981; color: white; padding: 4px 8px; font-weight: bold;');
    console.log(`Total searches: ${totalSearchesUsed}, Total Claude calls: ${totalClaudeCalls}`);

    // STAGE 3: Process each chunk with Claude
    console.log('Stage 3: Processing chunks...');
    
    const processedChunks = [];
    const writingSystemPrompt = writingPrompt || `You are an expert blog rewriter. Fix errors, improve clarity, maintain tone.`;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkNum = i + 1;
      
      console.log(`Processing chunk ${chunkNum}/${chunks.length} (${chunk.length} chars)...`);

      const chunkPrompt = chunks.length > 1 
        ? `This is PART ${chunkNum} of ${chunks.length} of a blog post. Rewrite this section based on research findings.

BRAVE SEARCH RESULTS:
${researchFindings}

SECTION ${chunkNum} CONTENT:
${chunk}

⚠️ PRICING POLICY - NEVER AUTO-UPDATE PRICING:
- DO NOT update pricing automatically (pricing is verified manually by team)
- Keep ALL pricing exactly as stated in original blog
- If you see pricing in search results: IGNORE it and keep original
- Pricing updates require manual human verification

✅ WHAT TO UPDATE (from official sources only):
- Features and capabilities (especially NEW features not mentioned in blog)
- NEW AI features, integrations, automation capabilities
- Platform limits and quotas (only from official docs)
- Statistics and benchmarks (from authoritative sources)
- Technical specifications (from official technical docs)

🔍 MISSING FEATURES DETECTION - VERY IMPORTANT:
- Actively look for NEW features in search results that blog doesn't mention
- Especially check for:
  * AI-powered capabilities (AI writing, AI personalization, AI analysis)
  * New integrations (Salesforce, HubSpot, Zapier, LinkedIn, etc.)
  * Automation features (workflow automation, smart sequencing)
  * Analytics features (advanced reporting, tracking)
  * Recent product updates and launches
- If official source mentions feature NOT in blog → ADD IT
- Format naturally: "Additionally, [Product] now offers [feature description]"
- Example: "SalesRobot also includes AI-powered message optimization and automated LinkedIn post scheduling"

SOURCE REQUIREMENTS:
- ONLY trust OFFICIAL sources:
  * site:companyname.com pages
  * Official documentation (.com/docs, .com/help)
  * Official blogs (.com/blog from 2024-2025)
- IGNORE: Review sites, comparison sites, forums, outdated articles
- If uncertain: KEEP ORIGINAL TEXT

CRITICAL INSTRUCTIONS - FORMATTING:
- Preserve ALL HTML tags, structure, images, links EXACTLY
- Preserve ALL <a> tags with href, target, and attributes EXACTLY
- Preserve ALL heading tags (H1, H2, H3, H4, H5, H6) EXACTLY - do NOT change heading levels
- Preserve ALL bold/italic formatting EXACTLY
- Preserve ALL paragraph breaks and list structures EXACTLY
- Remove em-dashes, banned words, long sentences
- Use contractions, active voice
- Return ONLY the rewritten HTML for this section
- DO NOT add section headers or numbers
- Keep the exact same HTML structure and heading hierarchy

GOLDEN RULE: Pricing stays unchanged. Focus on adding NEW features and updating capabilities.`
        : `Based on the Brave search results, rewrite this complete blog post.

BRAVE SEARCH RESULTS:
${researchFindings}

BLOG CONTENT:
${chunk}

⚠️ PRICING POLICY - NEVER AUTO-UPDATE PRICING:
- DO NOT update pricing automatically (pricing is verified manually by team)
- Keep ALL pricing exactly as stated in original blog
- If you see pricing in search results: IGNORE it and keep original
- Pricing updates require manual human verification

✅ WHAT TO UPDATE (from official sources only):
- Features and capabilities (especially NEW features not mentioned in blog)
- NEW AI features, integrations, automation capabilities
- Platform limits and quotas (only from official docs)
- Statistics and benchmarks (from authoritative sources)
- Technical specifications (from official technical docs)

🔍 MISSING FEATURES DETECTION - VERY IMPORTANT:
- Actively look for NEW features in search results that blog doesn't mention
- Especially check for:
  * AI-powered capabilities (AI writing, AI personalization, AI analysis)
  * New integrations (Salesforce, HubSpot, Zapier, LinkedIn, etc.)
  * Automation features (workflow automation, smart sequencing)
  * Analytics features (advanced reporting, tracking)
  * Recent product updates and launches
- If official source mentions feature NOT in blog → ADD IT
- Format naturally: "Additionally, [Product] now offers [feature description]"
- Example: "SalesRobot also includes AI-powered message optimization and automated LinkedIn post scheduling"

SOURCE REQUIREMENTS:
- ONLY trust OFFICIAL sources:
  * site:companyname.com pages
  * Official documentation (.com/docs, .com/help)
  * Official blogs (.com/blog from 2024-2025)
- IGNORE: Review sites, comparison sites, forums, outdated articles
- If uncertain: KEEP ORIGINAL TEXT

CRITICAL INSTRUCTIONS - FORMATTING:
- Preserve ALL HTML tags, structure, images, links, widgets EXACTLY
- Preserve ALL <a> tags with href, target, and attributes EXACTLY
- Preserve ALL heading tags (H1, H2, H3, H4, H5, H6) EXACTLY - do NOT change heading levels
- Preserve ALL bold/italic formatting EXACTLY  
- Preserve ALL paragraph breaks and list structures EXACTLY
- Remove em-dashes, banned words, long sentences
- Use contractions, active voice
- Return ONLY the complete rewritten HTML
- NO explanations, just clean HTML with EXACT heading structure preserved

GOLDEN RULE: Pricing stays unchanged. Focus on adding NEW features and updating capabilities.`;

      const chunkResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        system: writingSystemPrompt,
        messages: [{ role: 'user', content: chunkPrompt }]
      });

      totalClaudeCalls++;
      
      console.log(`%c✓ Chunk ${chunkNum} processed`, 'color: #10b981;', `(${chunkResponse.content[0].text.length} chars output)`);

      let rewrittenChunk = '';
      for (const block of chunkResponse.content) {
        if (block.type === 'text') {
          rewrittenChunk += block.text;
        }
      }
      
      processedChunks.push(rewrittenChunk);
    }

    // STAGE 4: Combine chunks if needed
    const finalContent = processedChunks.join('\n');
    
    console.log('Analysis complete!');
    console.log(`Total searches: ${totalSearchesUsed}, Total Claude calls: ${totalClaudeCalls}`);

    res.json({
      content: finalContent,
      changes: allChanges,
      searchesUsed: totalSearchesUsed,
      claudeCalls: totalClaudeCalls,
      sectionsUpdated: processedChunks.length,
      duration: 0
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`ContentOps Backend running on port ${PORT}`);
});
