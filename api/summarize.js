module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { mode, headlines, descriptions, keyword } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키 미설정' });

  let prompt;

  // ── 연관 검색어 확장 ──────────────────────────
  if (mode === 'expand') {
    prompt = `방송영상 전공 입시 뉴스 검색 도우미입니다.
키워드: "${keyword}"

이 키워드로 한국 뉴스를 검색할 때 실제 기사에서 쓰이는 표현으로
연관 검색어 6개를 만들어주세요.

조건:
- 실제 뉴스 기사 제목에서 자주 쓰이는 표현
- 키워드의 하위 개념, 관련 기업/서비스명, 관련 이슈
- 2~5글자 핵심 단어 위주
- 한국어만

응답 형식 (JSON만, 다른 말 없이):
{"terms":["검색어1","검색어2","검색어3","검색어4","검색어5","검색어6"]}`;

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
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await response.json();
      const text = (data.content?.[0]?.text || '').trim();
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(200).json({ terms: [] });
    }
  }

  if (!headlines?.length) return res.status(400).json({ error: 'headlines 필요' });

  // ── AI 필터링 ─────────────────────────────────
  if (mode === 'filter') {
    const list = headlines.map((h, i) => {
      const desc = descriptions?.[i] ? ` / ${descriptions[i].slice(0, 80)}` : '';
      return `[${i}] ${h}${desc}`;
    }).join('\n');
    prompt = `당신은 방송영상 전공 입시 전문 큐레이터입니다.
키워드: "${keyword}"

아래 기사/칼럼 목록을 보고 판단하세요.

${list}

판단 기준:
1. 한국어 기사/칼럼인지 (제목에 한글 포함 필수)
2. "${keyword}"와 실질적으로 관련 있는지
   - 직접: 해당 키워드·하위 개념을 다루는 것
   - 간접: 미디어·방송·OTT·콘텐츠 산업 맥락에서 연관된 것
   - 제외: 완전 무관한 연예·스포츠·정치·경제 일반 뉴스

응답 형식 (JSON만, 다른 말 없이):
{"results":[{"idx":0,"relevant":true,"summary":"한 줄 요약"},{"idx":1,"relevant":false,"summary":""},...]}

모든 항목에 대해 빠짐없이 응답하세요.`;

  } else {
    // ── 3줄 요약 ───────────────────────────────
    const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
    prompt = `다음은 "${keyword}" 관련 최신 뉴스/칼럼 헤드라인들입니다.

${headlineText}

위 헤드라인들을 바탕으로:
1. 핵심 흐름을 3줄로 요약해주세요
2. 방송영상 입시생이 주목해야 할 핵심 키워드 3개를 뽑아주세요

형식:
【3줄 요약】
- (첫 번째)
- (두 번째)
- (세 번째)

【핵심 키워드】
#키워드1 #키워드2 #키워드3`;
  }

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
        max_tokens: mode === 'filter' ? 1500 : 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || '요청 실패' });
    }
    const data = await response.json();
    const text = (data.content?.[0]?.text || '').trim();
    if (mode === 'filter') {
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        return res.status(200).json(parsed);
      } catch(e) {
        return res.status(500).json({ error: 'AI 파싱 실패' });
      }
    } else {
      return res.status(200).json({ summary: text });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
