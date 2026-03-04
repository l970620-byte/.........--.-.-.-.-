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
      const desc = descriptions?.[i] ? `\n   본문요약: ${descriptions[i].slice(0,150)}` : '';
      return `[${i}] ${h}${desc}`;
    }).join('\n');

    const prompt = `당신은 방송영상 전공 입시 전문 큐레이터입니다.
키워드: "${keyword}"
${list}
각 항목은 제목과 본문요약으로 구성됩니다. 제목만이 아닌 본문요약까지 함께 읽고 판단하세요.

판단 기준 (3가지 모두 충족해야 relevant:true):
1. 한국어 기사/칼럼인지 (제목에 한글 포함 필수)
2. 방송·미디어·OTT·콘텐츠·저널리즘·영상제작·플랫폼·크리에이터 분야와 실질적으로 관련 있는지
3. 단순 연예인 사생활·스포츠 경기결과·주식/부동산 투자·일반 정치 기사는 제외 (단, 미디어 산업·방송 정책 관점이 있으면 포함)

한 줄 요약은 본문요약을 참고해 방송영상 입시생 시각에서 핵심을 작성
응답 형식 (JSON만):
{"results":[{"idx":0,"relevant":true,"summary":"한 줄 요약"},{"idx":1,"relevant":false,"summary":""},...]}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:1500, messages:[{role:'user',content:prompt}] })
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
    const cacheKey = `writing:${keyword}:${today}`;
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return res.status(200).json({ topics: cached, cached: true });
    } catch(e) {}

    const prompt = `당신은 서울예술대학교 방송영상전공 입시 작문 출제 교수입니다.
키워드: "${keyword}"

이 키워드와 관련된 최신 미디어·방송 이슈를 바탕으로
실제 입시 시험에 출제될 법한 작문 문제 4개를 만들어주세요.

각 문제는 다음을 포함해야 합니다:
- title: 작문 유형 (예: 서술형 작문 / 논술형 작문 / 의견 제시형 / 현상 분석형)
- question: 실제 시험지에 나오는 형태의 문제 지문 (2~4문장. "~에 대해 서술하시오" 형태로 마무리)
- hint: 이 문제를 잘 쓰기 위한 핵심 포인트 2가지 (짧게)
- tags: 관련 핵심 개념 태그 3개
- searchKeyword: 이 문제 관련 기사를 찾을 때 쓸 검색어 1개 (한국어, 5자 이내)

작문 유형은 서술형·논술형·의견 제시형·현상 분석형 골고루 포함
방송영상전공 입시 실전 작문 문제처럼 구체적이고 명확하게 출제

응답 형식 (JSON만, 다른 텍스트 없이):
{"topics":[
  {"title":"문제 유형","question":"실제 문제 지문","hint":["핵심포인트1","핵심포인트2"],"tags":["태그1","태그2","태그3"],"searchKeyword":"검색어"},
  {"title":"문제 유형","question":"실제 문제 지문","hint":["핵심포인트1","핵심포인트2"],"tags":["태그1","태그2","태그3"],"searchKeyword":"검색어"},
  {"title":"문제 유형","question":"실제 문제 지문","hint":["핵심포인트1","핵심포인트2"],"tags":["태그1","태그2","태그3"],"searchKeyword":"검색어"},
  {"title":"문제 유형","question":"실제 문제 지문","hint":["핵심포인트1","핵심포인트2"],"tags":["태그1","태그2","태그3"],"searchKeyword":"검색어"}
]}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:1200, messages:[{role:'user',content:prompt}] })
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
