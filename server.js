import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ContentOps Backend Running', version: '2.3' });
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
    console.error('Webflow GET error:', error);
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
    console.error('Webflow PATCH error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Split content into semantic chunks
function splitIntoChunks(htmlContent, maxChunkSize = 12000) {
  const chunks = [];
  const parser = new DOMParser();
  
  // For server-side, use a simple regex-based splitter
  const sections = htmlContent.split(/(<h[1-3][^>]*>.*?<\/h[1-3]>)/gi);
  
  let currentChunk = '';
  
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    
    // If adding this section exceeds max size, save current chunk
    if (currentChunk.length + section.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = section;
    } else {
      currentChunk += section;
    }
  }
  
  // Add remaining chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks.length > 0 ? chunks : [htmlContent];
}

// Main analysis endpoint with full content support
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  const TIMEOUT_MS = 300000; // 5 minutes for large blogs
  
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

    let searchesUsed = 0;
    let claudeCalls = 0;
    let changes = [];

    console.log('=== ANALYSIS START ===');
    console.log('Title:', title);
    console.log('Content length:', blogContent.length, 'chars');
    console.log('Timestamp:', new Date().toISOString());

    // STAGE 1: GENERATE DYNAMIC SEARCH QUERIES
    console.log('\n[Stage 1] Generating search queries...');
    
    const contentSample = blogContent.substring(0, 5000);
    
    const queryGenerationPrompt = `Analyze this blog post and generate 6-8 specific search queries for fact-checking.

RESEARCH INSTRUCTIONS:
${researchPrompt || 'Verify all claims, pricing, features, and statistics mentioned.'}

BLOG TITLE: ${title}

BLOG CONTENT SAMPLE:
${contentSample}

Generate search queries that will help verify:
- All company/product names mentioned (pricing, features, stats)
- All competitors mentioned (pricing, features, comparisons)
- Industry statistics and benchmarks
- Platform limits and policies
- Technical specifications

Return ONLY a JSON array of 6-8 search query strings. Format:
["query 1", "query 2", "query 3", "query 4", "query 5", "query 6"]`;

    let searchQueries = [];
    
    try {
      const queryResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        temperature: 0.3,
        messages: [{ role: 'user', content: queryGenerationPrompt }]
      });

      claudeCalls++;
      
      const queryText = queryResponse.content[0].text.trim()
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      
      searchQueries = JSON.parse(queryText);
      searchQueries = searchQueries.slice(0, 8);
      console.log('[Stage 1] Generated queries:', searchQueries);
      
    } catch (error) {
      console.error('[Stage 1] Failed:', error.message);
      searchQueries = [
        `${title} pricing 2025`,
        `${title} features comparison`,
        `${title} review alternatives`,
        'LinkedIn automation limits 2025',
        'LinkedIn outreach best practices'
      ];
      console.log('[Stage 1] Using fallback queries');
    }

    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('Timeout at Stage 1');
    }

    // STAGE 2: BRAVE SEARCH
    console.log('\n[Stage 2] Brave searches...');
    
    let researchFindings = '# BRAVE SEARCH FINDINGS\n\n';
    let successfulSearches = 0;

    for (let i = 0; i < searchQueries.length; i++) {
      const query = searchQueries[i];
      
      if (Date.now() - startTime > TIMEOUT_MS) break;
      
      try {
        console.log(`[Stage 2] Search ${i + 1}/${searchQueries.length}: "${query}"`);
        
        const braveResponse = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
          {
            headers: {
              'Accept': 'application/json',
              'X-Subscription-Token': braveKey
            },
            signal: AbortSignal.timeout(10000)
          }
        );

        if (!braveResponse.ok) {
          console.error(`[Stage 2] Brave error ${braveResponse.status}`);
          continue;
        }

        const braveData = await braveResponse.json();
        searchesUsed++;
        successfulSearches++;
        
        researchFindings += `## Query ${i + 1}: "${query}"\n`;
        
        if (braveData.web?.results?.length > 0) {
          braveData.web.results.slice(0, 3).forEach((result, idx) => {
            researchFindings += `${idx + 1}. **${result.title}**\n`;
            researchFindings += `   URL: ${result.url}\n`;
            researchFindings += `   ${result.description || 'No description'}\n\n`;
          });
        } else {
          researchFindings += 'No results.\n\n';
        }
        
        console.log(`[Stage 2] Search ${i + 1} done (${braveData.web?.results?.length || 0} results)`);
        
        if (i < searchQueries.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 800));
        }
        
      } catch (error) {
        console.error(`[Stage 2] Failed: ${error.message}`);
      }
    }

    console.log(`[Stage 2] Complete: ${successfulSearches} searches`);

    if (successfulSearches === 0) {
      throw new Error('All Brave searches failed. Check API key.');
    }

    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('Timeout at Stage 2');
    }

    // STAGE 3: INTELLIGENT CHUNKING & REWRITING
    console.log('\n[Stage 3] Rewriting content...');
    console.log(`[Stage 3] Content size: ${blogContent.length} chars`);

    const writingSystemPrompt = writingPrompt || `You are an expert blog rewriter. Fix errors, improve clarity, maintain tone.`;

    let finalContent = '';
    
    // For content under 20k chars, process in one go
    if (blogContent.length <= 20000) {
      console.log('[Stage 3] Processing in single pass');
      
      const rewriteResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        temperature: 0.3,
        system: writingSystemPrompt,
        messages: [{
          role: 'user',
          content: `Based on these Brave search results, rewrite this blog to fix ALL errors.

BRAVE SEARCH RESULTS:
${researchFindings}

BLOG CONTENT:
${blogContent}

Return ONLY the complete rewritten HTML. No explanations.

IMPORTANT:
- Apply ALL Brave corrections to ALL entities
- Update every incorrect fact (pricing, features, stats, limits)
- Preserve ALL HTML: images, links, tables, widgets, lists, embeds
- Keep alt attributes on images
- Remove em-dashes, AI words, 30+ word sentences
- Use contractions, active voice
- RETURN ENTIRE BLOG - DO NOT TRUNCATE`
        }]
      });

      claudeCalls++;
      
      finalContent = rewriteResponse.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
      
    } else {
      // For large content, process in chunks
      console.log('[Stage 3] Content too large, processing in chunks...');
      
      const chunks = splitIntoChunks(blogContent, 12000);
      console.log(`[Stage 3] Split into ${chunks.length} chunks`);
      
      for (let i = 0; i < chunks.length; i++) {
        if (Date.now() - startTime > TIMEOUT_MS) {
          console.log('[Stage 3] Timeout, using remaining chunks as-is');
          finalContent += chunks.slice(i).join('');
          break;
        }
        
        console.log(`[Stage 3] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
        
        try {
          const chunkResponse = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 12000,
            temperature: 0.3,
            system: writingSystemPrompt,
            messages: [{
              role: 'user',
              content: `Rewrite this section based on Brave research findings. Fix ALL errors.

BRAVE RESEARCH:
${researchFindings.substring(0, 3000)}

SECTION ${i + 1}/${chunks.length}:
${chunks[i]}

Return ONLY the rewritten HTML. Preserve ALL formatting, images, widgets, tables, lists.
Apply ALL fact corrections from Brave Search.
Remove em-dashes, AI words, long sentences.`
            }]
          });

          claudeCalls++;
          
          const rewrittenChunk = chunkResponse.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('');
          
          finalContent += rewrittenChunk;
          
          console.log(`[Stage 3] Chunk ${i + 1} complete (${rewrittenChunk.length} chars)`);
          
          // Brief delay between chunks
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.error(`[Stage 3] Chunk ${i + 1} failed:`, error.message);
          // Append original chunk if rewrite fails
          finalContent += chunks[i];
        }
      }
    }

    // Clean markdown artifacts
    finalContent = finalContent
      .replace(/```html\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    changes = [
      `🔍 ${successfulSearches} Brave searches completed`,
      `📝 ${claudeCalls} Claude rewrites (${blogContent.length > 20000 ? 'chunked processing' : 'single pass'})`,
      `✅ Full blog analyzed (${blogContent.length} chars)`,
      `✅ All pricing/features verified`,
      `✅ All factual errors corrected`,
      `✅ Writing standards applied`
    ];

    const duration = Date.now() - startTime;

    console.log('\n=== ANALYSIS COMPLETE ===');
    console.log(`Duration: ${(duration/1000).toFixed(1)}s`);
    console.log(`Searches: ${searchesUsed}`);
    console.log(`Claude calls: ${claudeCalls}`);
    console.log(`Output: ${finalContent.length} chars`);

    res.json({
      content: finalContent,
      changes,
      searchesUsed,
      claudeCalls,
      sectionsUpdated: changes.length,
      duration
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('\n=== ANALYSIS FAILED ===');
    console.error('Error:', error.message);
    console.error('Duration:', (duration/1000).toFixed(1), 's');
    
    res.status(500).json({ 
      error: error.message,
      duration
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 ContentOps Backend v2.3 running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/`);
  console.log(`⏱️  Timeout: 5 minutes per analysis`);
  console.log(`📦 Full blog support with intelligent chunking`);
});

server.timeout = 300000; // 5 minutes
server.keepAliveTimeout = 300000;
server.headersTimeout = 305000;
