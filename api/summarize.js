module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { mode, headlines, descriptions, keyword } = req.body;
  if (!headlines?.length) return res.status(400).json({ error: '기사가 없습니다.' });
  
  // 무료 열쇠의 이름입니다.
  const apiKey = process.env.GEMINI_API_KEY; 
  if (!apiKey) return res.status(500).json({ error: 'API 키 미설정 (Vercel 설정을 확인하세요)' });

  let prompt;
  if (mode === 'filter') {
    const list = headlines.map((h, i) => `[${i}] ${h}`).join('\n');
    prompt = `당신은 방송영상 전공 입시 전문 큐레이터입니다. 키워드: "${keyword}". 아래 목록 중 관련 있는 뉴스만 골라 JSON으로 응답하세요: {"results":[{"idx":0,"relevant":true,"summary":"한 줄 요약"}]}\n\n${list}`;
  } else {
    const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
    prompt = `다음 뉴스들을 바탕으로 "${keyword}"의 핵심 흐름을 3줄 요약하고 키워드 3개를 뽑아주세요.\n${headlineText}\n\n형식:\n【3줄 요약】\n- 내용\n\n【핵심 키워드】\n#키워드`;
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
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
    return res.status(500).json({ error: "AI 연결 실패" });
  }
}
