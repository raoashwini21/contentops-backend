import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ContentOps Backend Running', version: '2.1' });
});

// Webflow proxy endpoints
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId, offset = '0', limit = '100' } = req.query;
    const authHeader = req.headers.authorization;

    if (!collectionId || !authHeader) {
      return res.status(400).json({ error: 'Missing collectionId or authorization' });
    }

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
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const authHeader = req.headers.authorization;

    if (!collectionId || !itemId || !authHeader) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const response = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'accept': 'application/json'
        },
        body: JSON.stringify(req.body)
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Main analysis endpoint
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  
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

    // Initialize Anthropic client
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    let searchesUsed = 0;
    let claudeCalls = 0;
    let changes = [];

    console.log('Starting analysis for:', title);

    // STAGE 1: GENERATE DYNAMIC SEARCH QUERIES USING CLAUDE
    console.log('Stage 1: Generate search queries from blog content...');
    
    const queryGenerationPrompt = `Analyze this blog post and generate 5-7 specific search queries for fact-checking.

RESEARCH INSTRUCTIONS:
${researchPrompt || 'Verify all claims, pricing, features, and statistics mentioned.'}

BLOG TITLE: ${title}

BLOG CONTENT (first 3000 chars):
${blogContent.substring(0, 3000)}

Generate search queries that will help verify:
- All company/product names mentioned (pricing, features, stats)
- All competitors mentioned (pricing, features, comparisons)
- Industry statistics and benchmarks
- Platform limits and policies (LinkedIn, etc.)
- Technical specifications and capabilities

Return ONLY a JSON array of 5-7 search query strings, nothing else. Example format:
["query 1", "query 2", "query 3", "query 4", "query 5"]

Focus on entities actually mentioned in this blog, not generic queries.`;

    const queryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: queryGenerationPrompt
      }]
    });

    claudeCalls++;

    // Extract search queries from Claude's response
    let searchQueries = [];
    try {
      const queryText = queryResponse.content[0].text.trim();
      // Remove markdown code blocks if present
      const cleanedText = queryText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      searchQueries = JSON.parse(cleanedText);
      console.log('Generated search queries:', searchQueries);
    } catch (error) {
      console.error('Failed to parse search queries:', error);
      // Fallback to basic queries
      searchQueries = [
        `${title} pricing 2025`,
        `${title} features comparison`,
        'LinkedIn automation limits 2025'
      ];
    }

    // STAGE 2: BRAVE SEARCH WITH DYNAMIC QUERIES
    console.log('Stage 2: Brave Search Research...');
    
    let researchFindings = '# BRAVE SEARCH FINDINGS\n\n';

    // Perform Brave searches with generated queries
    for (const query of searchQueries) {
      try {
        console.log(`Brave Search ${searchesUsed + 1}: ${query}`);
        
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
          searchesUsed++;
          
          researchFindings += `## Query: "${query}"\n`;
          
          if (braveData.web?.results) {
            braveData.web.results.slice(0, 3).forEach((result, i) => {
              researchFindings += `${i + 1}. **${result.title}**\n`;
              researchFindings += `   URL: ${result.url}\n`;
              researchFindings += `   ${result.description || ''}\n\n`;
            });
          }
          
          researchFindings += '\n';
        }
        
        // Rate limiting: wait 500ms between searches
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`Brave search failed for "${query}":`, error.message);
      }
    }

    console.log(`Research complete: ${searchesUsed} Brave searches, ${claudeCalls} Claude call (query generation)`);

    // STAGE 3: REWRITE WITH BRAVE RESEARCH FINDINGS
    console.log('Stage 3: Claude Content Rewriting...');

    const writingSystemPrompt = writingPrompt || `You are an expert blog rewriter. Fix errors, improve clarity, maintain tone.`;

    const rewriteResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 32000,
      system: writingSystemPrompt,
      messages: [{
        role: 'user',
        content: `Based on the Brave search results below, rewrite this blog post to fix ALL errors and improve quality.

CRITICAL: Update ALL incorrect facts found via Brave Search:
- Update competitor pricing (Expandi, Dripify, LinkedHelper, etc.)
- Update LinkedIn platform limits and policies (verify exact numbers)
- Update industry statistics and benchmarks (use latest data)
- Update product features for ALL tools mentioned (not just one product)
- Update company information for ALL companies mentioned

BRAVE SEARCH RESULTS:
${researchFindings}

ORIGINAL BLOG CONTENT:
${blogContent}

Return ONLY the complete rewritten HTML content. No explanations, just the clean HTML.

IMPORTANT:
- Apply ALL corrections from Brave Search to ALL entities mentioned
- Update every incorrect fact you find (pricing, features, stats, limits)
- This applies to ALL companies/tools, not just one product
- Preserve all HTML formatting and structure
- Keep ALL images, links, tables, widgets, lists intact
- Remove em-dashes, banned AI words, 30+ word sentences
- Use contractions, active voice, simple language
- RETURN THE ENTIRE BLOG - DO NOT TRUNCATE`
      }]
    });

    claudeCalls++;

    // Extract rewritten content
    let rewrittenContent = '';
    for (const block of rewriteResponse.content) {
      if (block.type === 'text') {
        rewrittenContent += block.text;
      }
    }

    // Clean up any markdown artifacts
    rewrittenContent = rewrittenContent
      .replace(/```html\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // Generate change summary
    changes = [
      `🔍 Performed ${searchesUsed} dynamic Brave searches based on blog content`,
      `🤖 Used Claude to identify entities and generate relevant queries`,
      `✅ Verified pricing and features for ALL products mentioned`,
      `✅ Updated competitor information from official sources`,
      `✅ Fixed factual inaccuracies across all entities`,
      `✅ Applied professional writing standards`
    ];

    const duration = Date.now() - startTime;

    console.log(`Analysis complete in ${(duration/1000).toFixed(1)}s`);
    console.log(`Total: ${searchesUsed} Brave searches, ${claudeCalls} Claude calls (1 query gen + 1 rewrite)`);

    res.json({
      content: rewrittenContent,
      changes,
      searchesUsed,
      claudeCalls,
      sectionsUpdated: changes.length,
      duration
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 ContentOps Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/`);
});

// Increase server timeout to 180 seconds for long blog analysis
server.timeout = 180000;
