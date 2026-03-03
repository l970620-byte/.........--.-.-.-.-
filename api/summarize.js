module.exports = async function handler(req, res) {
  // 웹사이트 접속 허용 설정 (보안/연결 설정)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });

  const { headlines, keyword } = req.body;
  if (!headlines || headlines.length === 0) {
    return res.status(400).json({ error: '분석할 뉴스가 없습니다.' });
  }

  // Vercel 설정에서 가져올 무료 API 키 이름 (중요!)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경 변수에 GEMINI_API_KEY를 등록해주세요.' });
  }

  // AI에게 보낼 명령문 (방영과 입시 맞춤형 프롬프트)
  const newsText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const prompt = `당신은 방송영상 전공 입시 전문가입니다. 다음 뉴스 헤드라인들을 읽고 "${keyword}"와 관련된 핵심 흐름을 3줄로 요약하고, 입시생이 주목해야 할 핵심 키워드 3개를 뽑아주세요.

뉴스 목록:
${newsText}

출력 형식:
【3줄 요약】
- (입시 관점의 핵심 요약 1)
- (입시 관점의 핵심 요약 2)
- (입시 관점의 핵심 요약 3)

【핵심 키워드】
#키워드1 #키워드2 #키워드3`;

  try {
    // 구글 Gemini 무료 API 호출 (Flash 모델은 매우 빠르고 무료입니다)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await response.json();
    
    if (!response.ok) throw new Error(data.error?.message || 'API 호출 실패');

    const resultText = data.candidates[0].content.parts[0].text;
    
    // index.html에서 기다리는 'summary' 이름으로 데이터 전달
    return res.status(200).json({ summary: resultText });

  } catch (error) {
    return res.status(500).json({ error: 'AI 분석 실패: ' + error.message });
  }
};
