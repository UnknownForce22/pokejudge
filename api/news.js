export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

  // Check cache first — only refresh if older than 7 days
  const cacheRes = await fetch(`${supabaseUrl}/rest/v1/news_cache?order=created_at.desc&limit=1`, {
    headers: {
      'Authorization': `Bearer ${supabaseSecret}`,
      'apikey': supabaseSecret
    }
  });

  if (cacheRes.ok) {
    const cached = await cacheRes.json();
    if (cached && cached[0]) {
      const cacheAge = Date.now() - new Date(cached[0].created_at).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (cacheAge < sevenDays) {
        // Return cached news
        return res.status(200).json({ 
          news: JSON.parse(cached[0].content),
          cached: true,
          lastUpdated: cached[0].created_at
        });
      }
    }
  }

  // Cache is stale or empty — fetch fresh news from Claude
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `Search for the latest Pokémon TCG judge and competitive news from the past 2 weeks. Focus on: new rules taking effect, rotation updates, format changes, banned/limited cards, tournament rule updates, and official Play! Pokémon announcements.

Respond ONLY with a JSON array, no extra text:
[
  {
    "title": "Short headline",
    "summary": "2-3 sentence summary of what this means for players and judges",
    "category": "Rules" | "Rotation" | "Tournament" | "Format" | "Announcement",
    "date": "approximate date",
    "important": true | false
  }
]

Include 4-6 most relevant news items. Mark as important=true if it affects tournament legality or judge calls.`
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Parse JSON from response
    let news;
    try {
      const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const start = clean.indexOf('[');
      const end = clean.lastIndexOf(']');
      news = JSON.parse(clean.slice(start, end + 1));
    } catch(e) {
      news = [{ 
        title: "News temporarily unavailable", 
        summary: "Please check back later for the latest Pokémon TCG news and rule updates.",
        category: "Announcement",
        date: new Date().toLocaleDateString(),
        important: false
      }];
    }

    // Save to cache
    await fetch(`${supabaseUrl}/rest/v1/news_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseSecret}`,
        'apikey': supabaseSecret,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        id: 1,
        content: JSON.stringify(news),
        created_at: new Date().toISOString()
      })
    });

    return res.status(200).json({ 
      news, 
      cached: false,
      lastUpdated: new Date().toISOString()
    });

  } catch (err) {
    console.error('News error:', err);
    return res.status(500).json({ error: err.message });
  }
}
