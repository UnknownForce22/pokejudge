import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, token } = req.body;

  if (!question) return res.status(400).json({ error: 'No question provided' });
  if (!token) return res.status(401).json({ error: 'Not logged in', redirect: '/login.html' });

  // Verify the user with Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', redirect: '/login.html' });
  }

  // Check usage for free users (5 rulings per day)
  const today = new Date().toISOString().split('T')[0];
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  const isPaid = profile?.is_paid || false;

  if (!isPaid) {
    const usageCount = (profile?.last_ruling_date === today) ? (profile?.daily_count || 0) : 0;
    if (usageCount >= 5) {
      return res.status(429).json({
        error: 'Daily limit reached',
        message: 'You have used your 5 free rulings for today. Upgrade for unlimited access!',
        limitReached: true
      });
    }
    // Update usage count
    await supabase.from('profiles').upsert({
      id: user.id,
      email: user.email,
      daily_count: usageCount + 1,
      last_ruling_date: today,
      is_paid: false,
      updated_at: new Date().toISOString()
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

Rules for your response:
- verdict must be one of: LEGAL (play is allowed), ILLEGAL (play is not allowed), CONDITIONAL (depends on conditions), INFO (general info, no clear legal/illegal determination)
- summary should be written as a judge would explain the ruling to players — clear, neutral, authoritative
- evidence array MUST have 2-4 items from different sources when possible
- For evidence, cite specific rule numbers, Compendium entries, or card text verbatim
- Be accurate — if unsure, say so in the summary and use verdict INFO
- Always check for: special timing rules, effect stacking, ability interactions, format legality`;

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
