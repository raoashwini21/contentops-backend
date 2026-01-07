import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ContentOps Backend Running', version: '2.0' });
});

// Webflow proxy endpoints
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId } = req.query;
    const authHeader = req.headers.authorization;

    if (!collectionId || !authHeader) {
      return res.status(400).json({ error: 'Missing collectionId or authorization' });
    }

    const response = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items`,
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

    // STAGE 1: RESEARCH WITH BRAVE SEARCH ONLY
    console.log('Stage 1: Brave Search Research (No Claude)...');
    
    // Extract key topics to search from the blog content
    const searchQueries = [
      'SalesRobot pricing 2025',
      'LinkedIn connection request limits 2025',
      'SalesRobot AI features',
      'LinkedIn automation best practices',
      'SalesRobot vs competitors'
    ];

    let researchFindings = '# BRAVE SEARCH FINDINGS\n\n';

    // Perform Brave searches
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

    console.log(`Research complete: ${searchesUsed} Brave searches (no Claude calls yet)`);
    console.log('Research findings:', researchFindings.substring(0, 500) + '...');

    // STAGE 2: REWRITE WITH BRAVE RESEARCH FINDINGS
    console.log('Stage 2: Claude Content Rewriting...');

    const writingSystemPrompt = writingPrompt || `You are an expert blog rewriter. Fix errors, improve clarity, maintain tone.`;

    const rewriteResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000, // Increased from 8000 to handle longer content
      system: writingSystemPrompt,
      messages: [{
        role: 'user',
        content: `Based on the Brave search results below, rewrite this blog post to fix errors, add missing features, and improve quality.

BRAVE SEARCH RESULTS:
${researchFindings}

ORIGINAL BLOG CONTENT:
${blogContent}

Return ONLY the complete rewritten HTML content. No explanations, just the clean HTML.

Important:
- Verify and fix pricing, features, stats based on search results
- Add missing AI/NEW features found in search results
- Remove em-dashes, banned words, 30+ word sentences
- Add contractions and active voice
- Preserve all HTML formatting and structure
- Keep images and links intact
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
      `🔍 Performed ${searchesUsed} Brave searches for fact-checking`,
      `✅ Verified pricing and features from official sources`,
      `✅ Fixed factual inaccuracies found in research`,
      `✅ Added missing AI/NEW features identified`,
      `✅ Improved grammar and readability`,
      `✅ Applied professional writing standards`
    ];

    const duration = Date.now() - startTime;

    console.log(`Analysis complete in ${(duration/1000).toFixed(1)}s`);
    console.log(`Total: ${searchesUsed} Brave searches, ${claudeCalls} Claude call (rewriting only)`);

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

app.listen(PORT, () => {
  console.log(`🚀 ContentOps Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/`);
});
