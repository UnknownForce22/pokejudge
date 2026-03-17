export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, token } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided' });
  if (!token) return res.status(401).json({ error: 'Not logged in', redirect: '/login.html' });

  // Verify user with Supabase REST API (no import needed)
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

  // Get user from token
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': supabaseSecret
    }
  });

  if (!userRes.ok) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', redirect: '/login.html' });
  }

  const user = await userRes.json();
  const userId = user.id;
  const userEmail = user.email;

  // Get profile
  const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=*`, {
    headers: {
      'Authorization': `Bearer ${supabaseSecret}`,
      'apikey': supabaseSecret
    }
  });

  const profiles = await profileRes.json();
  const profile = profiles[0] || null;
  const isPaid = profile?.is_paid || false;
  const today = new Date().toISOString().split('T')[0];

  if (!isPaid) {
    const usageCount = (profile?.last_ruling_date === today) ? (profile?.daily_count || 0) : 0;
    if (usageCount >= 5) {
      return res.status(429).json({
        error: 'Daily limit reached',
        message: 'You have used your 5 free rulings for today. Upgrade for unlimited access!',
        limitReached: true
      });
    }

    // Upsert profile usage
    await fetch(`${supabaseUrl}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseSecret}`,
        'apikey': supabaseSecret,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        id: userId,
        email: userEmail,
        daily_count: (profile?.last_ruling_date === today ? (profile?.daily_count || 0) : 0) + 1,
        last_ruling_date: today,
        is_paid: false,
        updated_at: new Date().toISOString()
      })
    });
  }

  const systemPrompt = `You are PokéJudge, an expert Pokémon Trading Card Game judge assistant. Your role is to answer rulings questions by consulting official sources.

When answering, ALWAYS respond ONLY with a JSON object (no markdown code fences, no extra text) with this exact structure:
{
  "verdict": "LEGAL" | "ILLEGAL" | "CONDITIONAL" | "INFO",
  "summary": "Clear 2-4 sentence explanation of the ruling for a judge to communicate to players",
  "evidence": [
    {
      "source": "Official Rulebook" | "Compendium" | "Tournament Rules" | "Card Text" | "Web Search",
      "text": "Specific rule, compendium entry, or card text that supports this ruling"
    }
  ]
}

Rules:
- verdict must be LEGAL, ILLEGAL, CONDITIONAL, or INFO
- summary should be written as a judge would explain the ruling — clear, neutral, authoritative
- evidence array MUST have 2-4 items from different sources when possible
- Be accurate — if unsure, use verdict INFO`;

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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Pokémon TCG ruling question: ${question}` }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const usageCount = (profile?.last_ruling_date === today ? profile?.daily_count || 0 : 0);
    const remaining = isPaid ? 'unlimited' : Math.max(0, 4 - usageCount);
    return res.status(200).json({ result: text, remaining, isPaid });

  } catch (err) {
    console.error('Ruling error:', err);
    return res.status(500).json({ error: err.message });
  }
}
