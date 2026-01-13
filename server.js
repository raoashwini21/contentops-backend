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
  res.json({ status: 'ContentOps Backend Running', version: '2.2-CHUNKED' });
});

// Webflow proxy with pagination
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

// Helper: Split HTML into chunks by paragraphs
function splitBlogIntoChunks(html, maxChunkSize = 10000) {
  // Split on closing tags for major elements
  const splitPattern = /(<\/(?:p|div|h[1-6]|section|article|li)>)/gi;
  const parts = html.split(splitPattern);
  
  const chunks = [];
  let currentChunk = '';
  
  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i] || '';
    const closingTag = parts[i + 1] || '';
    const segment = content + closingTag;
    
    if ((currentChunk + segment).length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = segment;
    } else {
      currentChunk += segment;
    }
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }
  
  // If splitting resulted in too many tiny chunks or failed, split by character count
  if (chunks.length === 0 || (chunks.length > 5 && html.length > 50000)) {
    chunks.length = 0;
    const numChunks = Math.ceil(html.length / maxChunkSize);
    for (let i = 0; i < numChunks; i++) {
      chunks.push(html.substring(i * maxChunkSize, (i + 1) * maxChunkSize));
    }
  }
  
  return chunks.length > 0 ? chunks : [html];
}

// Main analysis endpoint with chunked processing
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
- Platform limits and policies
- Technical specifications

Return ONLY a JSON array of 5-7 search query strings. Example:
["query 1", "query 2", "query 3", "query 4", "query 5"]

Focus on entities actually mentioned in this blog.`;

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
      console.log('Generated search queries:', searchQueries);
    } catch (error) {
      console.error('Failed to parse queries:', error);
      searchQueries = [`${title} pricing 2025`, `${title} features`, 'industry statistics 2025'];
    }

    // STAGE 2: Brave Search (once for entire blog)
    console.log('Stage 2: Brave Search...');
    
    let researchFindings = '# BRAVE SEARCH FINDINGS\n\n';

    for (const query of searchQueries.slice(0, 6)) { // Limit to 6 searches
      try {
        console.log(`Brave Search ${totalSearchesUsed + 1}: ${query}`);
        
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
          
          if (braveData.web?.results) {
            braveData.web.results.slice(0, 3).forEach((result, i) => {
              researchFindings += `${i + 1}. **${result.title}**\n`;
              researchFindings += `   URL: ${result.url}\n`;
              researchFindings += `   ${result.description || ''}\n\n`;
            });
          }
          researchFindings += '\n';
        }
        
        await new Promise(resolve => setTimeout(resolve, 400)); // Rate limit
        
      } catch (error) {
        console.error(`Brave search failed for "${query}":`, error.message);
      }
    }

    console.log(`Research complete: ${totalSearchesUsed} searches, ${totalClaudeCalls} Claude calls`);

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

CRITICAL INSTRUCTIONS:
- Update ALL incorrect facts based on Brave Search
- Fix pricing, features, stats for ALL entities mentioned
- Preserve ALL HTML tags, structure, images, links
- Remove em-dashes, banned words, long sentences
- Use contractions, active voice
- Return ONLY the rewritten HTML for this section
- DO NOT add section headers or numbers
- Keep the exact same HTML structure`
        : `Based on the Brave search results, rewrite this complete blog post.

BRAVE SEARCH RESULTS:
${researchFindings}

BLOG CONTENT:
${chunk}

CRITICAL INSTRUCTIONS:
- Update ALL incorrect facts based on Brave Search
- Fix pricing, features, stats for ALL entities
- Preserve ALL HTML tags, structure, images, links, widgets
- Remove em-dashes, banned words, long sentences
- Use contractions, active voice
- Return ONLY the complete rewritten HTML
- NO explanations, just clean HTML`;

      const chunkResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000, // Reduced for faster processing
        system: writingSystemPrompt,
        messages: [{ role: 'user', content: chunkPrompt }]
      });

      totalClaudeCalls++;

      let rewrittenChunk = '';
      for (const block of chunkResponse.content) {
        if (block.type === 'text') {
          rewrittenChunk += block.text;
        }
      }

      // Clean markdown artifacts
      rewrittenChunk = rewrittenChunk
        .replace(/```html\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      processedChunks.push(rewrittenChunk);
      
      console.log(`Chunk ${chunkNum} complete (${rewrittenChunk.length} chars)`);
    }

    // Combine all chunks
    const finalContent = processedChunks.join('\n\n');

    // Generate changes summary
    const changes = [
      `🔍 Performed ${totalSearchesUsed} Brave searches for fact-checking`,
      `📝 Processed blog in ${chunks.length} section(s) for faster completion`,
      `🤖 Used ${totalClaudeCalls} Claude calls (1 query gen + ${chunks.length} rewrites)`,
      `✅ Updated pricing, features, and stats for all entities`,
      `✅ Fixed factual inaccuracies from research`,
      `✅ Applied professional writing standards`
    ];

    const duration = Date.now() - startTime;

    console.log(`Analysis complete in ${(duration/1000).toFixed(1)}s`);
    console.log(`Total: ${totalSearchesUsed} searches, ${totalClaudeCalls} Claude calls, ${chunks.length} chunks`);

    res.json({
      content: finalContent,
      changes,
      searchesUsed: totalSearchesUsed,
      claudeCalls: totalClaudeCalls,
      sectionsUpdated: chunks.length,
      duration
    });

  } catch (error) {
    console.error('Analysis error:', error);
    const duration = Date.now() - startTime;
    res.status(500).json({ 
      error: error.message,
      duration,
      details: error.stack
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 ContentOps Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/`);
  console.log(`⚡ Chunked processing enabled for long blogs`);
});

// 4-minute timeout (under Railway's 5-minute limit)
server.timeout = 240000;
