const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { mode, headlines, descriptions, keyword } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API 키 미설정' });

  const today = new Date().toISOString().slice(0, 10);

  // expand: 24시간 캐시
  if (mode === 'expand') {
    const cacheKey = `expand:${keyword}:${today}`;
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return res.status(200).json({ terms: cached, cached: true });
    } catch(e) {}

    const prompt = `당신은 한국 뉴스 검색 전문가입니다.
키워드: "${keyword}"
이 키워드 관련 기사를 구글 뉴스에서 최대한 많이 찾을 수 있도록
실제 뉴스 기사 제목에 등장하는 표현으로 검색어 10개를 만들어주세요.
다음 각도를 모두 포함하세요: 상위 개념, 하위 개념, 관련 기관·기업명, 관련 이슈, 유사어
응답 형식 (JSON만):
{"terms":["검색어1","검색어2","검색어3","검색어4","검색어5","검색어6","검색어7","검색어8","검색어9","검색어10"]}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:400, messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      const text = (data.content?.[0]?.text||'').trim();
      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
      try { await kv.set(cacheKey, parsed.terms, { ex: 86400 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(200).json({ terms: [] });
    }
  }

  // filter: 6시간 캐시
  if (mode === 'filter') {
    if (!headlines?.length) return res.status(400).json({ error: 'headlines 필요' });
    const hashStr = headlines.slice(0,5).join('|');
    const cacheKey = `filter:${keyword}:${hashStr.slice(0,80)}`;
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return res.status(200).json({ results: cached, cached: true });
    } catch(e) {}

    const list = headlines.map((h,i) => {
      const desc = descriptions?.[i] ? `\n   본문요약: ${descriptions[i].slice(0,400)}` : '';
      return `[${i}] ${h}${desc}`;
    }).join('\n');

    const prompt = `당신은 방송영상 전공 입시 전문 큐레이터입니다.
아래 기사 목록을 보고 방송영상 입시생에게 유용한 기사만 골라주세요.

${list}

relevant:true 조건 → 방송·미디어·OTT·콘텐츠·플랫폼·저널리즘·영상제작·크리에이터 산업 직접 관련
relevant:false 조건 → 연예인 열애/사생활, 스포츠 경기결과, 주식/코인/부동산, 해외 정치, 광고성 기사, 제목만 키워드 포함이고 본문은 무관한 기사

제목과 본문요약을 반드시 둘 다 읽고 판단. 본문이 미디어 산업과 무관하면 false.
응답 형식 (JSON만, 다른 텍스트 없이):
{"results":[{"idx":0,"relevant":true,"summary":"입시생 시각 한 줄 요약"},...]}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:800, messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      const text = (data.content?.[0]?.text||'').trim();
      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
      try { await kv.set(cacheKey, parsed.results, { ex: 21600 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({ error: 'AI 파싱 실패' });
    }
  }

  // writing: 작문 주제 생성 — 1시간 캐시
  if (mode === 'writing') {
    const cacheKey = `writing:${keyword}:${today}:${Date.now()}`;  // 캐시 비활성화
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return res.status(200).json({ topics: cached, cached: true });
    } catch(e) {}

    const prompt = `당신은 서울예술대학교 방송영상전공 입시 작문 출제 교수입니다.
키워드: "${keyword}"

이 키워드를 바탕으로 서울예대 방송영상전공 입시 작문 예제 1개를 만들어주세요.

[실제 기출 — 25년도 수시]
1. 방송영상 산업에서 활용되는 디에이징과 딥페이크 기술에 대해 논하시오
2. 방송을 시청할 수 있는 포맷이 다양해졌다. 방송에 미치는 영향에 대해 논하시오
3. '자기혐오'를 주제로 프로그램 기획안을 작성하시오
4. 글로벌 OTT에서 공개된 콘텐츠가 지상파 방송사에 송출된 사례를 언급하고, 이에 제작자가 나아가야 할 방향성에 대해 논하시오
5. 플레이브와 같은 버추얼 휴먼 가수에 대한 개인적인 생각을 논하시오
6. 최근 예능이 포맷 부족과 시청자 이탈로 위기를 맞이했다. 이를 해결할 방법과 본인의 견해를 작성하시오
7. 지상파 프로그램 흥행 여부를 과거엔 시청률로 판단했지만 최근엔 흥행 여부를 판단하는 요소가 바뀌고 있다. 그 요소가 무엇인지 근거를 들어 설명하시오
8. 영상 제작에서 적용할 수 있는 표현 가능한 제작 방법에 대해 설명하시오
9. 지상파의 일일 드라마를 폐지 또는 유지 중 하나를 선택하고 그에 맞는 주장을 제시하시오
10. 케이블 방송 말고도 요즘 콘텐츠가 범람하여 표준어 및 콘텐츠 윤리성 필터링 약화로 문제가 생기고 있다. 이 문제에 대해 논하시오
11. 최근 대부분의 예능·시사교양 프로그램들이 관찰 형식의 영상 문법으로 이루어져 있다. 새로운 영상 제작 기술을 바탕으로 관찰 형식의 영상 문법이 변화해야 할 방향에 대해 논하시오
12. 신기술을 이용한 콘텐츠에 대해서 설명하시오

[기존 기출 — 24년도]
- 2024 수시: "공영방송 수신료 분리징수가 논란인 이유와 자신의 생각을 서술하시오"
- 2024 정시: "예술인과 창작자에 대한 도덕성은 결국 사회가 요구하는 잣대이자 그들이 가져야 할 태도라 할 수 있다. 이에 대한 자신의 견해를 서술하시오"
- 2023 수시: "숏폼이 트렌드다. 틱톡이 숏폼 유행을 이끈 뒤 유튜브·인스타그램도 숏폼을 선보였다. 숏폼 콘텐츠가 인기를 끈 이유와 각 플랫폼 콘텐츠를 설명하시오"
- 2021 수시: "광고수입이 점점 하락하는 방면인데 앞으로 방송국들이 저예산 방송을 찍기위한 아이디어를 서술하시오"

출제 유형 패턴:
1. 기술/현상 설명형 (디에이징, 딥페이크, 신기술)
2. 현상 분석 + 영향 논술형 (포맷 다양화, OTT 영향)
3. 기획안 작성형 ('자기혐오' 프로그램 기획)
4. 찬반 선택 + 근거 제시형 (일일 드라마 폐지/유지)
5. 문제 해결책 제안형 (예능 위기, 필터링 약화)
6. 개인 견해 에세이형 (버추얼 휴먼, 창작자 윤리)

위 기출과 패턴을 참고해서 키워드와 연결된 새 예제를 출제하세요.
매번 다른 유형으로 출제하세요.

형식:
- title: 작문 유형 (기술설명형/현상분석형/기획안작성형/찬반논술형/해결책제안형/견해에세이형 중 하나)
- question: 실제 시험지 문제 지문 (2~3문장, "~서술하시오"로 마무리)
- hint: 핵심 작성 포인트 2가지 (각 20자 이내)
- tags: 관련 개념 태그 3개
- searchKeyword: 관련 기사 검색어 (5자 이내)

응답 형식 (JSON만):
{"topics":[{"title":"유형","question":"문제 지문","hint":["포인트1","포인트2"],"tags":["태그1","태그2","태그3"],"searchKeyword":"검색어"}]}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:600, messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      const text = (data.content?.[0]?.text||'').trim();
      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
      try { await kv.set(cacheKey, parsed.topics, { ex: 3600 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({ error: 'AI 파싱 실패: ' + e.message });
    }
  }

  // 3줄 요약 (수동 호출, 캐시 없음)
  if (!headlines?.length) return res.status(400).json({ error: 'headlines 필요' });
  const headlineText = headlines.map((h,i)=>`${i+1}. ${h}`).join('\n');
  const prompt = `다음은 "${keyword}" 관련 최신 뉴스/칼럼 헤드라인들입니다.\n\n${headlineText}\n\n위 헤드라인들을 바탕으로:\n1. 핵심 흐름을 3줄로 요약해주세요\n2. 방송영상 입시생이 주목해야 할 핵심 키워드 3개를 뽑아주세요\n\n형식:\n【3줄 요약】\n• (첫 번째)\n• (두 번째)\n• (세 번째)\n\n【핵심 키워드】\n#키워드1 #키워드2 #키워드3`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:500, messages:[{role:'user',content:prompt}] })
    });
    const data = await response.json();
    const text = (data.content?.[0]?.text||'').trim();
    return res.status(200).json({ summary: text });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
