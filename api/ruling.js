export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get the question from the app
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'No question provided' });
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
    // Call Claude API using the secret key stored in environment variables
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,  // 🔒 Secret key from Vercel vault
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

    if (!response.ok) {
      throw new Error(data.error?.message || 'Claude API error');
    }

    // Pull out just the text from Claude's response
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    return res.status(200).json({ result: text });

  } catch (err) {
    console.error('Ruling error:', err);
    return res.status(500).json({ error: err.message });
  }
}
