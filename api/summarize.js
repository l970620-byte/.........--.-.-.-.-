const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async function handler(req, res) {
  // CORS — 허용 도메인 제한 (환경변수 ALLOWED_ORIGIN 없으면 Vercel 프리뷰만 허용)
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const origin = req.headers.origin || '';
  const isAllowed = allowedOrigin
    ? origin === allowedOrigin
    : origin.endsWith('.vercel.app') || origin === 'http://localhost:3000';
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : '');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (!isAllowed && req.method !== 'OPTIONS') {
    return res.status(403).json({ error: '허용되지 않은 도메인입니다.' });
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { mode, keyword } = req.body;
  const headlines    = Array.isArray(req.body.headlines)    ? req.body.headlines    : [];
  const descriptions = Array.isArray(req.body.descriptions) ? req.body.descriptions : [];
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
      const raw = (data.content?.[0]?.text||'').trim();
      // { } 사이 JSON만 추출 — 마크다운/텍스트 섞여도 안전
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch(_) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('JSON 없음: ' + raw.slice(0, 120));
        parsed = JSON.parse(m[0]);
      }
      try { await kv.set(cacheKey, parsed.terms, { ex: 86400 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      console.error('[terms] 오류:', e.message);
      return res.status(500).json({ error: 'terms 생성 실패: ' + e.message });
    }
  }

  // filter: 6시간 캐시
  if (mode === 'filter') {
    if (!headlines.length) return res.status(400).json({ error: 'headlines 필요 (배열)' });
    const hashStr = crypto.createHash('sha256')
      .update(keyword + '|' + headlines.join('|'))
      .digest('hex')
      .slice(0, 32);
    const cacheKey = `filter:${hashStr}`;
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
      const raw = (data.content?.[0]?.text||'').trim();
      // { } 사이 JSON만 추출 — 마크다운/텍스트 섞여도 안전
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch(_) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('JSON 없음: ' + raw.slice(0, 120));
        parsed = JSON.parse(m[0]);
      }
      try { await kv.set(cacheKey, parsed.results, { ex: 21600 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      console.error('[filter] 오류:', e.message);
      return res.status(500).json({ error: 'filter 실패: ' + e.message });
    }
  }

  // ── 대본 생성 ──
  if (mode === 'script') {
    const { genre, situation } = req.body;
    const usedScripts = Array.isArray(req.body.usedScripts) ? req.body.usedScripts : [];
    const usedInfo = usedScripts.length
      ? `\n\n[이미 생성한 대본 — 절대 반복 금지]\n${usedScripts.map(s=>'- '+s).join('\n')}\n위 장르+상황 조합과 인물 구도, 갈등 패턴이 겹치지 않아야 합니다.`
      : '';
    const prompt = `당신은 한국 드라마 전문 작가입니다. 서울예대 방송영상전공 입시 대본분석 연습용 씬을 창작해주세요.

장르: ${genre}
상황: ${situation}

대본 형식 규칙 (반드시 준수):
- 씬 헤더: "S#숫자. 장소 - 시간대" 형식 (예: S#7. 회사 복도 - 낮)
- 지문: (소괄호로 감싸기) 예: (민준이 창문을 바라보며)
- 대사: "인물명: 대사내용" 형식 (예: 민준: 그게 무슨 말이야?)
- 인물이 감정을 담아 말할 때: "인물명 (감정): 대사" (예: 서아 (떨리는 목소리로): 미안해.)
- 등장인물 2~3명, 대사 12~16줄, 지문 4~6개
- 갈등과 감정이 명확하게 드러날 것
- 실제 방영 드라마 수준의 자연스러운 한국어\${usedInfo}

응답 형식 (JSON만, 다른 텍스트 없이):
{"script":{"sceneNum":"S#7","setting":"회사 복도 - 낮","characters":["민준","서아"],"script":"S#7. 회사 복도 - 낮\n(퇴근 시간. 텅 빈 복도. 민준이 코트를 들고 나오다 멈춘다.)\n서아: (뒤에서) 민준씨.\n민준: (돌아보지 않고) 할 말 없어요.\n서아 (한 발짝 다가서며): 그래도 들어줘요. 딱 한 번만.\n민준: (차갑게 돌아보며) 한 번? 몇 번이나 들었는데요.\n(서아가 입술을 깨문다. 눈물이 차오른다.)\n서아: 내가... 틀렸어요. 그때.\n민준: (긴 침묵 후) 이미 늦었어요.\n(민준이 걸어간다. 서아가 그 자리에 선다.)"}}`; 

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({model:'claude-haiku-4-5', max_tokens:700, messages:[{role:'user',content:prompt}]})
      });
      const data = await response.json();
      const raw = (data.content?.[0]?.text||'').trim();
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch(e1) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('JSON 없음: ' + raw.slice(0,120));
        parsed = JSON.parse(m[0]);
      }
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({error: 'AI 파싱 실패: '+e.message});
    }
  }

  // ── 모범 대본분석 ──
  if (mode === 'scriptAnalysis') {
    const { script, genre, situation } = req.body;
    const prompt = `당신은 서울예대 방송영상전공 입시 전문 코치입니다.
아래 드라마 씬을 분석하고, 반드시 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.

장르: ${genre} / 상황: ${situation}
대본: ${script}

JSON 형식 (이것만 출력):
{"analysis":{"characters":"인물 관계와 갈등 구조 2~3문장","theme":"씬의 주제와 감정선 2~3문장","direction":"연출 포인트 예시 — 카메라/편집/조명/음악 각 1줄씩 (예시임을 명시)","interview":"S#번호는 ~장면으로, ~갈등이 드러납니다. 저라면 ~로 연출하겠습니다. 형식으로 3~4문장"}}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({
          model:'claude-haiku-4-5',
          max_tokens:800,
          system:'당신은 JSON만 출력하는 분석 도구입니다. 마크다운, 코드블록, 추가 텍스트 없이 순수 JSON만 반환하세요.',
          messages:[{role:'user',content:prompt}]
        })
      });
      const data = await response.json();
      const raw = (data.content?.[0]?.text||'').trim();
      // JSON 추출 — 중첩 객체 대응
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch(e1) {
        // 앞뒤 텍스트 제거 후 재시도
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('JSON 없음: ' + raw.slice(0,120));
        parsed = JSON.parse(m[0]);
      }
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({error: 'AI 파싱 실패: '+e.message});
    }
  }

  // ── 직접 쓴 분석 AI 첨삭 ──
  if (mode === 'scriptFeedback') {
    const { script, genre, userAnalysis } = req.body;
    const prompt = `당신은 서울예대 방송영상전공 입시 전문 코치입니다.
학생이 작성한 대본 분석 4항목을 채점하고 피드백을 주세요.

장르: ${genre}
대본:
${script}

학생 분석:
${userAnalysis}

채점 기준 (각 항목 1~5점):
- intro (씬 소개): 장소/인물/상황이 명확한가
- conflict (갈등 구조): 두 인물의 욕구 충돌이 구체적으로 설명됐는가
- dialogue (핵심 대사): 선택 이유와 감정 해석이 적절한가
- direction (연출 제안): 구체적이고 실현 가능한가

응답 형식 (JSON만):
{"scores":{"intro":4,"conflict":3,"dialogue":4,"direction":2},"feedback":"잘한 점: ...\n보완할 점: ...\n교수 예상 반응: ...\n개선 한 문장: ..."}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({model:'claude-haiku-4-5', max_tokens:600, messages:[{role:'user',content:prompt}]})
      });
      const data = await response.json();
      const raw = (data.content?.[0]?.text||'').trim();
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch(e1) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('JSON 없음: ' + raw.slice(0,120));
        parsed = JSON.parse(m[0]);
      }
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({error: e.message});
    }
  }

  // writing: 작문 주제 생성 — 캐시 비활성화
  if (mode === 'writing') {
    const usedTitles   = Array.isArray(req.body.usedTitles)   ? req.body.usedTitles   : [];
    const usedQuestions= Array.isArray(req.body.usedQuestions)? req.body.usedQuestions: [];
    const usedTags     = Array.isArray(req.body.usedTags)     ? req.body.usedTags     : [];
    const usedTypes    = Array.isArray(req.body.usedTypes)    ? req.body.usedTypes    : [];

    // writing 캐시 — 동일 키워드+이미생성목록 조합 1시간 캐시
    const wrHashStr = crypto.createHash('sha256')
      .update(keyword + '|' + usedTitles.join('|') + '|' + usedTypes.join('|'))
      .digest('hex').slice(0, 24);
    const wrCacheKey = `writing:${wrHashStr}`;
    try {
      const cached = await kv.get(wrCacheKey);
      if (cached) return res.status(200).json({ topics: cached });
    } catch(e) {}

    const usedInfo = usedTitles.length
      ? `\n\n[이미 생성된 예제 — 절대 반복 금지]\n${usedTitles.map((t,i)=>`- 유형명: ${usedTypes[i]||''} / 유형: ${t} / 문제: ${usedQuestions[i]||''} / 태그: ${usedTags[i]||''}`).join('\n')}\n\n위 유형명, 유형, 문제 각도, 핵심 태그(키워드) 모두 달라야 합니다. 같은 태그나 유형명이 하나라도 겹치면 안 됩니다.`
      : '';

    const prompt = `당신은 서울예대 방송영상전공 입시 작문 출제 교수입니다.
키워드: "${keyword}"${usedInfo}

[출제 유형 6가지 중 매번 다른 것으로]
기술설명형 / 현상분석형 / 기획안작성형 / 찬반논술형 / 해결책제안형 / 견해에세이형

[기출 패턴 — 실제 출제 스타일]
- "디에이징·딥페이크 기술에 대해 논하시오" (기술설명형)
- "지상파 일일드라마를 폐지/유지 중 선택하고 주장을 제시하시오" (찬반논술형)
- "버추얼 휴먼 가수에 대한 개인적 견해를 논하시오" (견해에세이형)
- "예능 포맷 부족·시청자 이탈 위기의 해결책을 서술하시오" (해결책제안형)
- "'자기혐오'를 주제로 프로그램 기획안을 작성하시오" (기획안작성형)
- "OTT 콘텐츠 지상파 송출 사례를 언급하고 제작자 방향성을 논하시오" (현상분석형)

위 스타일로 키워드 "\${keyword}"에만 집중한 새 예제 1개를 JSON으로만 출력하세요.
공영방송·수신료 주제로 빠지지 말 것.

{"topics":[{"title":"유형명","question":"문제 지문 (~서술하시오)","hint":["포인트1 20자이내","포인트2 20자이내"],"tags":["태그1","태그2","태그3"],"searchKeyword":"검색어5자이내"}]}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:400, messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      const raw = (data.content?.[0]?.text||'').trim();
      // { } 사이 JSON만 추출 — 마크다운/텍스트 섞여도 안전
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch(_) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('JSON 없음: ' + raw.slice(0, 120));
        parsed = JSON.parse(m[0]);
      }
      try { await kv.set(wrCacheKey, parsed.topics, { ex: 3600 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({ error: 'AI 파싱 실패: ' + e.message });
    }
  }

  // 3줄 요약 (수동 호출, 캐시 없음)
  if (!headlines.length) return res.status(400).json({ error: 'headlines 필요 (배열)' });
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
