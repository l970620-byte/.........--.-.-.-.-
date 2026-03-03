module.exports = async function handler(req, res) {
  // 웹사이트 연결 허용 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });

  const { mode, headlines, descriptions, keyword } = req.body;
  if (!headlines || headlines.length === 0) {
    return res.status(400).json({ error: '분석할 뉴스 데이터가 없습니다.' });
  }

  // Vercel 설정에 등록할 API 키 이름
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 설정에서 GEMINI_API_KEY를 확인해주세요.' });
  }

  // AI에게 보낼 명령문 (프롬프트)
  let prompt;
  if (mode === 'filter') {
    const list = headlines.map((h, i) => `[${i}] ${h}`).join('\n');
    prompt = `당신은 방송영상 전공 입시 전문 큐레이터입니다. 키워드: "${keyword}". 아래 목록 중 관련 있는 뉴스만 골라 JSON으로 응답하세요: {"results":[{"idx":0,"relevant":true,"summary":"한 줄 요약"}]}\n\n${list}`;
  } else {
    const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
    prompt = `당신은 방송영상 전공 입시 전문가입니다. 다음 뉴스들을 읽고 "${keyword}"와 관련된 핵심 흐름을 3줄 요약하고, 입시생이 주목해야 할 키워드 3개를 뽑아주세요.

뉴스 목록:
${headlineText}

형식:
【3줄 요약】
- 내용1
- 내용2
- 내용3

【핵심 키워드】
#키워드1 #키워드2 #키워드3`;
  }

  try {
    // 요청하신 Gemini 2.0 Flash API 주소 사용
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'API 호출 중 오류가 발생했습니다.');
    }

    const resultText = data.candidates[0].content.parts[0].text.trim();

    if (mode === 'filter') {
      const jsonText = resultText.replace(/```json|```/g, '').trim();
      return res.status(200).json(JSON.parse(jsonText));
    } else {
      // index.html에서 summary라는 이름으로 데이터를 받으므로 맞춰서 전달
      return res.status(200).json({ summary: resultText });
    }
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'AI 분석 실패: ' + error.message });
  }
};
