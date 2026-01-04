import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ 
    product: 'ContentOps API',
    version: '2.0.0',
    status: 'Running'
  });
});

// Webflow proxy
app.all('/api/webflow', async (req, res) => {
  const { collectionId, itemId } = req.query;
  const token = req.headers.authorization;
  
  if (!token) return res.status(401).json({ error: 'Auth required' });
  
  try {
    let url = `https://api.webflow.com/v2/collections/${collectionId}/items`;
    if (itemId) url += `/${itemId}`;
    if (req.method === 'GET' && !itemId) url += '?limit=100';
    
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: req.method === 'PATCH' ? JSON.stringify(req.body) : undefined
    });
    
    res.status(response.status).json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Smart Analysis with Brave + Sectional Claude
app.post('/api/analyze', async (req, res) => {
  const { blogContent, title, anthropicKey, braveKey } = req.body;
  
  if (!blogContent || !anthropicKey || !braveKey) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    console.log('ContentOps: Starting smart analysis...');
    const startTime = Date.now();
    
    // STEP 1: Divide into sections
    const sections = divideBlog(blogContent, title);
    console.log(`Divided into ${sections.length} sections`);
    
    // STEP 2: Fact-check with Brave
    const factChecks = await factCheckWithBrave(sections, braveKey);
    console.log(`Brave searches: ${factChecks.searchesUsed}`);
    
    // STEP 3: Rewrite outdated sections with Claude
    const updated = await rewriteWithClaude(sections, factChecks, anthropicKey);
    console.log(`Claude calls: ${updated.claudeCalls}`);
    
    // STEP 4: Combine
    const finalContent = combineContent(updated.sections);
    const duration = Date.now() - startTime;
    
    console.log(`Analysis complete in ${duration}ms`);
    
    res.json({
      success: true,
      changes: factChecks.changes,
      searchesUsed: factChecks.searchesUsed,
      claudeCalls: updated.claudeCalls,
      sectionsUpdated: updated.sectionsUpdated,
      content: finalContent,
      duration: duration
    });
    
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

function divideBlog(content, title) {
  const sections = [{ type: 'title', text: title, check: false }];
  const paras = content.split(/<\/?[ph][1-6]?>/).filter(p => p.trim().length > 50);
  
  for (const para of paras) {
    if (/\$\d+|price|pricing/i.test(para)) {
      sections.push({ type: 'pricing', text: para, check: true });
    } else if (/feature|AI|new/i.test(para)) {
      sections.push({ type: 'features', text: para, check: true });
    } else {
      sections.push({ type: 'content', text: para, check: false });
    }
  }
  
  return sections;
}

async function factCheckWithBrave(sections, braveKey) {
  const changes = [];
  let searchesUsed = 0;
  const results = [];
  
  for (const section of sections.filter(s => s.check)) {
    if (section.type === 'pricing') {
      const toolMatch = section.text.match(/(\w+)\s*-?\s*\$(\d+)/);
      if (toolMatch && searchesUsed < 5) {
        const [_, tool, price] = toolMatch;
        const query = `${tool} pricing 2024 2025`;
        
        try {
          const res = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`,
            { headers: { 'X-Subscription-Token': braveKey } }
          );
          searchesUsed++;
          
          const data = await res.json();
          const desc = data.web?.results?.[0]?.description || '';
          const newPrice = desc.match(/\$(\d+)/)?.[1];
          
          if (newPrice && newPrice !== price) {
            changes.push(`${tool}: $${price} → $${newPrice}`);
            results.push({ section, outdated: true, newInfo: `$${newPrice}` });
          } else {
            results.push({ section, outdated: false });
          }
        } catch (err) {
          console.error('Brave search error:', err);
          results.push({ section, outdated: false });
        }
      }
    }
    
    if (section.type === 'features' && searchesUsed < 5) {
      const toolMatch = section.text.match(/\b(SalesRobot|LinkedIn|Lemlist|Apollo)\b/i);
      if (toolMatch) {
        const tool = toolMatch[1];
        const query = `${tool} new features 2024`;
        
        try {
          const res = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`,
            { headers: { 'X-Subscription-Token': braveKey } }
          );
          searchesUsed++;
          
          const data = await res.json();
          const desc = data.web?.results?.[0]?.description || '';
          
          if (desc.toLowerCase().includes('ai')) {
            changes.push(`${tool}: New AI features found`);
            results.push({ section, outdated: true, newInfo: desc.substring(0, 100) });
          } else {
            results.push({ section, outdated: false });
          }
        } catch (err) {
          console.error('Brave search error:', err);
          results.push({ section, outdated: false });
        }
      }
    }
  }
  
  return { changes, searchesUsed, results };
}

async function rewriteWithClaude(sections, factChecks, anthropicKey) {
  let claudeCalls = 0;
  let sectionsUpdated = 0;
  const updated = [];
  
  for (const section of sections) {
    const factCheck = factChecks.results.find(r => r.section === section);
    
    if (factCheck?.outdated) {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 800,
            messages: [{
              role: 'user',
              content: `Update this text with new info. Keep same length and style.

Original: ${section.text}
Update: ${factCheck.newInfo}

Return ONLY updated text. Fix em-dashes (—) to (-).`
            }]
          })
        });
        
        claudeCalls++;
        sectionsUpdated++;
        
        const data = await res.json();
        const rewritten = data.content[0].text;
        updated.push({ ...section, text: rewritten });
      } catch (err) {
        console.error('Claude error:', err);
        updated.push(section);
      }
    } else {
      updated.push(section);
    }
  }
  
  return { sections: updated, claudeCalls, sectionsUpdated };
}

function combineContent(sections) {
  return sections.map(s => s.text).join('\n\n');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ContentOps API running on port ${PORT}`);
});
