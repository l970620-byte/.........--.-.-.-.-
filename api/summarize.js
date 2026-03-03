module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { mode, headlines, descriptions, keyword } = req.body;
  if (!headlines?.length) return res.status(400).json({ error: 'headlines 필요' });
  
  // Vercel 설정에서 넣을 이름입니다.
  const apiKey = process.env.GEMINI_API_KEY; 
  if (!apiKey) return res.status(500).json({ error: 'API 키 미설정' });

  let prompt;
  if (mode === 'filter') {
    const list = headlines.map((h, i) => {
      const desc = descriptions?.[i] ? ` / ${descriptions[i].slice(0, 80)}` : '';
      return `[${i}] ${h}${desc}`;
    }).join('\n');
    prompt = `당신은 방송영상 전공 입시 전문 큐레이터입니다. 키워드: "${keyword}". 아래 목록을 보고 "${keyword}"와 관련된 한국어 기사만 골라주세요. 응답은 무조건 JSON 형식으로만 하세요: {"results":[{"idx":0,"relevant":true,"summary":"한 줄 요약"}]}\n\n${list}`;
  } else {
    const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
    prompt = `다음은 "${keyword}" 관련 뉴스들입니다. 핵심 흐름을 3줄 요약하고 핵심 키워드 3개를 뽑아주세요.\n${headlineText}\n\n형식:\n【3줄 요약】\n- 내용1\n- 내용2\n- 내용3\n\n【핵심 키워드】\n#키워드1 #키워드2 #키워드3`;
  }

  try {
    // Google Gemini 무료 API 주소입니다.
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
    });

    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text.trim();

    if (mode === 'filter') {
      const jsonText = text.replace(/```json|```/g, '').trim();
      return res.status(200).json(JSON.parse(jsonText));
    } else {
      return res.status(200).json({ summary: text });
    }
  } catch (e) {
    return res.status(500).json({ error: "AI 요약 중 오류가 발생했습니다." });
  }
}
