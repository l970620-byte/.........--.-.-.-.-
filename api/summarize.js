// api/summarize.js — Vercel 서버리스 함수
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키 없음' });

  // 키 앞 10자리만 반환 (테스트용)
  return res.status(200).json({ summary: 'KEY:' + apiKey.slice(0, 10) });
}
// api/summarize.js — Vercel 서버리스 함수
// API 키는 Vercel 환경변수 ANTHROPIC_API_KEY 에 저장 (코드에 노출 안 됨)

export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { headlines, keyword } = req.body;
  if (!headlines?.length) return res.status(400).json({ error: 'headlines 필요' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키 미설정' });

  const headlineText = headlines
    .map((h, i) => `${i + 1}. ${h}`)
    .join('\n');

  const prompt = `다음은 "${keyword}" 관련 최신 뉴스 헤드라인들입니다.

${headlineText}

위 헤드라인들을 바탕으로:
1. 핵심 흐름을 3줄로 요약해주세요 (각 줄은 "•"로 시작)
2. 방송영상 입시생이 주목해야 할 핵심 키워드 3개를 뽑아주세요

형식:
【3줄 요약】
- (첫 번째)
- (두 번째)
- (세 번째)

【핵심 키워드】
#키워드1 #키워드2 #키워드3`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || '요약 실패' });
    }

    const data = await response.json();
    const summary = data.content?.[0]?.text || '';
    return res.status(200).json({ summary });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
