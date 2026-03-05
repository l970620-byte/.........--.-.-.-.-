const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// JSON 추출 헬퍼 — greedy match 방지: 마지막 }를 기준으로 가장 바깥 객체 추출
function extractJSON(raw) {
  // 코드블록 제거
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // 1차: 직접 파싱
  try { return JSON.parse(cleaned); } catch(_) {}
  // 2차: 첫 { ~ 마지막 } 슬라이스
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('JSON 없음: ' + cleaned.slice(0, 120));
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch(e) {
    throw new Error('JSON 파싱 실패: ' + e.message + ' / 원문: ' + cleaned.slice(start, start + 120));
  }
}

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
  // keyword가 필요한 모드에서만 검증
  const KEYWORD_REQUIRED = ['expand','filter','writing'];
  if (KEYWORD_REQUIRED.includes(mode) && !keyword) {
    return res.status(400).json({ error: 'keyword 파라미터가 필요합니다.' });
  }
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
      if (cached) return res.status(200).json({ ...cached, cached: true });
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
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:400, system:'당신은 뉴스 요약 전문 어시스턴트입니다. 요청한 형식(【3줄 요약】, 【핵심 키워드】)을 정확히 지켜 텍스트로 답변하세요.', messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      // { } 사이 JSON만 추출 — 마크다운/텍스트 섞여도 안전
      const parsed = extractJSON(raw);
      try { await kv.set(cacheKey, { ...parsed, _v: SCHEMA_VER }, { ex: 86400 }); } catch(e) {}
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
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:800, system:'당신은 뉴스 요약 전문 어시스턴트입니다. 요청한 형식(【3줄 요약】, 【핵심 키워드】)을 정확히 지켜 텍스트로 답변하세요.', messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      // { } 사이 JSON만 추출 — 마크다운/텍스트 섞여도 안전
      const parsed = extractJSON(raw);
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
    const weaknessTip = typeof req.body.weaknessTip === 'string' ? req.body.weaknessTip.slice(0,80) : '';
    const usedInfo = usedScripts.length
      ? `\n\n[이미 생성한 대본 — 절대 반복 금지]\n${usedScripts.map(s=>'- '+s).join('\n')}\n위 장르+상황 조합과 인물 구도, 갈등 패턴이 겹치지 않아야 합니다.`
      : '';
    const prompt = `당신은 한국 드라마 전문 작가입니다. 서울예대 방송영상전공 입시 대본분석 연습용 씬을 창작해주세요.

장르: ${genre}
상황: ${situation}

[좋은 씬의 조건 — 반드시 충족]
1. 인물 욕망과 장애물: 각 인물이 이 씬에서 원하는 것과 그것을 막는 것이 행동으로 드러날 것
2. 행동 대사: 감정을 직접 말하지 말 것 ("슬퍼요" ❌ → 컵을 내려놓는 행동 ✅)
3. 씬 내 반전: 씬 중반에 힘의 균형이 한 번 뒤집힐 것
4. 지문의 역할: 단순 동작 묘사가 아닌 카메라 앵글·감정 온도를 암시하는 지문
5. 마지막 여운: 마지막 대사나 지문이 다음 씬을 궁금하게 만들 것

[형식]
- 씬 헤더: S#숫자. 장소 - 시간대
- 지문: (소괄호)
- 대사: 인물명: 대사 / 인물명 (감정지시): 대사
- 등장인물 2~3명, 대사 20~28줄, 지문 7~10개
- 실제 방영 드라마 수준의 자연스러운 한국어${usedInfo}${weaknessTip ? '\n\n[이번 씬 집중 포인트] ' + weaknessTip : ''}

아래 형식을 정확히 지켜서 응답하세요:

===JSON===
{"sceneNum":"S#숫자","setting":"장소 - 시간대","characters":["인물1","인물2"]}
===SCRIPT===
(여기에 실제 대본 텍스트를 자유롭게 작성)`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1500,
          system: '아래 형식을 반드시 지켜 응답하세요. ===JSON=== 다음에 메타데이터 JSON 한 줄, ===SCRIPT=== 다음에 대본 텍스트. 다른 형식이나 추가 설명 없이.',
          messages: [{role:'user', content:prompt}]
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();

      // delimiter 파싱
      const jsonMatch = raw.match(/===JSON===\s*([\s\S]*?)\s*===SCRIPT===/);
      const scriptMatch = raw.match(/===SCRIPT===\s*([\s\S]*?)$/);
      if (!jsonMatch || !scriptMatch) {
        // fallback: 기존 extractJSON
        const parsed = extractJSON(raw);
        return res.status(200).json(parsed);
      }
      const meta = JSON.parse(jsonMatch[1].trim());
      const scriptText = scriptMatch[1].trim();
      return res.status(200).json({
        script: { ...meta, script: scriptText }
      });
    } catch(e) {
      return res.status(500).json({error: 'AI 파싱 실패: ' + e.message});
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
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      // JSON 추출 — 중첩 객체 대응
      const parsed = extractJSON(raw);
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({error: 'AI 파싱 실패: '+e.message});
    }
  }

  // ── 모범 작문 생성 ──
  if (mode === 'writingModel') {
    const { question, keyword, title } = req.body;
    if (!question) return res.status(400).json({ error: 'question 필요' });

    const prompt = `당신은 서울예대 방송영상전공 입시 작문 전문 코치입니다.
아래 입시 작문 문제에 대한 모범 답안을 작성하세요.

문제 유형: ${title || ''}
키워드: ${keyword || ''}
문제: ${question}

모범 답안 조건:
- 4문단 구성 (서론-본론1-본론2-결론)
- 각 문단 4~5문장, 전체 500~600자
- 서론: 현상/배경 제시 + 논점 명확히
- 본론1: 첫 번째 근거 + 구체적 사례
- 본론2: 두 번째 근거 또는 반론 고려
- 결론: 핵심 주장 재확인 + 방향 제시
- 방송·미디어 전공자 시각 반영
- "~다." 종결어미 일관 사용

순수 JSON만 출력하세요:
{"essay":{"p1":"intro paragraph","p2":"body1 paragraph","p3":"body2 paragraph","p4":"conclusion paragraph","tip":"one line strategy"}}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1200,
          system: '당신은 JSON만 출력하는 작문 코치입니다. 반드시 순수 JSON만 반환하고 마크다운이나 부연설명을 절대 포함하지 마세요.',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text || '').trim();
      const parsed = extractJSON(raw);
      return res.status(200).json(parsed);
    } catch(e) {
      console.error('[writingModel] 오류:', e.message);
      return res.status(500).json({ error: '모범 작문 생성 실패: ' + e.message });
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
        body: JSON.stringify({model:'claude-haiku-4-5', max_tokens:600, system:'당신은 JSON만 출력하는 도구입니다. 마크다운 없이 순수 JSON만 반환하세요.', messages:[{role:'user',content:prompt}]})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      const parsed = extractJSON(raw);
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({error: e.message});
    }
  }

  // ── 오늘의 참고 작품 ──
  // ── 작문 예제 생성 ──
  if (mode === 'writing') {
    const usedTitles   = Array.isArray(req.body.usedTitles)   ? req.body.usedTitles   : [];
    const usedQuestions= Array.isArray(req.body.usedQuestions)? req.body.usedQuestions: [];
    const usedTags     = Array.isArray(req.body.usedTags)     ? req.body.usedTags     : [];
    const usedTypes    = Array.isArray(req.body.usedTypes)    ? req.body.usedTypes    : [];

    const wrHashStr = crypto.createHash('sha256')
      .update(keyword + '|' + usedTitles.join('|') + '|' + usedTypes.join('|'))
      .digest('hex').slice(0, 24);
    const wrCacheKey = `writing:${wrHashStr}`;
    try {
      const cached = await kv.get(wrCacheKey);
      if (cached) return res.status(200).json({ topics: cached });
    } catch(e) {}

    const usedInfo = usedTitles.length
      ? `\n\n[이미 생성된 예제 — 절대 반복 금지]\n${usedTitles.map((t,i)=>`- 유형명: ${usedTypes[i]||''} / 유형: ${t} / 문제: ${usedQuestions[i]||''} / 태그: ${usedTags[i]||''}`).join('\n')}\n\n위 유형명, 유형, 문제 각도, 핵심 태그(키워드) 모두 달라야 합니다.`
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

위 스타일로 키워드 "${keyword}"에만 집중한 새 예제 1개를 JSON으로만 출력하세요.
공영방송·수신료 주제로 빠지지 말 것.

기획안작성형일 경우 반드시 plan 필드를 포함하세요:
{"topics":[{"title":"기획안작성형","question":"문제 지문","hint":["포인트1","포인트2"],"tags":["태그1","태그2"],"searchKeyword":"검색어","plan":{"programTitle":"프로그램 가제","format":"포맷 (예: 6부작 다큐멘터리)","target":"주 시청자층","concept":"핵심 콘셉트 1~2문장","episodes":[{"ep":"1화","title":"제목","desc":"내용 1문장"},{"ep":"2화","title":"제목","desc":"내용 1문장"},{"ep":"3화","title":"제목","desc":"내용 1문장"}],"channel":"편성 채널 제안","point":"기획 의도 1문장"}}]}

기획안작성형이 아닌 경우 plan 필드 없이:
{"topics":[{"title":"유형명","question":"문제 지문 (~서술하시오)","hint":["포인트1 20자이내","포인트2 20자이내"],"tags":["태그1","태그2","태그3"],"searchKeyword":"검색어5자이내"}]}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:400, system:'당신은 JSON만 출력하는 입시 작문 출제 도구입니다. 순수 JSON만 반환하고 마크다운이나 부연설명을 절대 포함하지 마세요.', messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      const parsed = extractJSON(raw);
      try { await kv.set(wrCacheKey, parsed.topics, { ex: 3600 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({ error: 'AI 파싱 실패: ' + e.message });
    }
  }

  // ── 모범 작문 생성 ──
  if (mode === 'writingModel') {
    const { question, keyword: wkw, title } = req.body;
    if (!question) return res.status(400).json({ error: 'question 필요' });

    const prompt = `당신은 서울예대 방송영상전공 입시 작문 전문 코치입니다.
아래 입시 작문 문제에 대한 모범 답안을 작성하세요.

문제 유형: ${title || ''}
키워드: ${wkw || keyword || ''}
문제: ${question}

모범 답안 조건:
- 4문단 구성 (서론-본론1-본론2-결론)
- 각 문단 4~5문장, 전체 500~600자
- 서론: 현상/배경 제시 + 논점 명확히
- 본론1: 첫 번째 근거 + 구체적 사례
- 본론2: 두 번째 근거 또는 반론 고려
- 결론: 핵심 주장 재확인 + 방향 제시
- 방송·미디어 전공자 시각 반영
- "~다." 종결어미 일관 사용

순수 JSON만 출력하세요:
{"essay":{"p1":"intro paragraph","p2":"body1 paragraph","p3":"body2 paragraph","p4":"conclusion paragraph","tip":"one line strategy"}}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1200,
          system: '당신은 JSON만 출력하는 작문 코치입니다. 반드시 순수 JSON만 반환하고 마크다운이나 부연설명을 절대 포함하지 마세요.',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text || '').trim();
      const parsed = extractJSON(raw);
      return res.status(200).json(parsed);
    } catch(e) {
      console.error('[writingModel] 오류:', e.message);
      return res.status(500).json({ error: '모범 작문 생성 실패: ' + e.message });
    }
  }

  // ── 작문 피드백 ──
  if (mode === 'writingFeedback') {
    const { essay } = req.body;
    if (!essay || essay.length < 50) return res.status(400).json({ error: '작문 내용이 너무 짧아요.' });

    const prompt = `당신은 서울예대 방송영상전공 입시 작문 전문 첨삭 교수입니다.
아래 학생의 작문을 꼼꼼하게 피드백해주세요.

[작문 원문]
${essay}

[분석 항목]
1. 비문/어색한 표현: 자연스럽지 않거나 문법적으로 틀린 문장
2. 사실 오류/불명확한 정보: 잘못된 정보나 근거 없는 주장
3. 잘 쓴 표현/강점: 논리적이거나 표현이 좋은 부분
4. 개선 제안: 더 좋은 표현이나 구성 방향

순수 JSON만 출력하세요:
{
  "score": 75,
  "summary": "총평 2~3문장",
  "errors": [{"original": "원문 구절", "issue": "문제점", "fix": "수정 제안"}],
  "facts": [{"original": "원문 구절", "issue": "사실 오류 또는 불명확한 근거"}],
  "strengths": [{"original": "원문 구절", "comment": "강점 설명"}],
  "suggestions": ["개선 제안 1", "개선 제안 2", "개선 제안 3"]
}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1200,
          system: '당신은 JSON만 출력하는 입시 작문 첨삭 도구입니다. 순수 JSON만 반환하고 마크다운이나 부연설명을 절대 포함하지 마세요.',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text || '').trim();
      const parsed = extractJSON(raw);
      return res.status(200).json(parsed);
    } catch(e) {
      return res.status(500).json({ error: '피드백 생성 실패: ' + e.message });
    }
  }

  // ── 3줄 요약 (수동 호출, 캐시 없음) ──
  if (mode === 'summary') {
    if (!headlines.length) return res.status(400).json({ error: 'headlines 필요 (배열)' });
    const headlineText = headlines.map((h,i)=>`${i+1}. ${h}`).join('\n');
    const prompt = `다음은"${keyword}" 관련 최신 뉴스/칼럼 헤드라인들입니다.\n\n${headlineText}\n\n위 헤드라인들을 바탕으로:\n1. 핵심 흐름을 3줄로 요약해주세요\n2. 방송영상 입시생이 주목해야 할 핵심 키워드 3개를 뽑아주세요\n\n형식:\n【3줄 요약】\n• (첫 번째)\n• (두 번째)\n• (세 번째)\n\n【핵심 키워드】\n#키워드1 #키워드2 #키워드3`;
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:500, system:'당신은 뉴스 요약 전문 어시스턴트입니다. 요청한 형식(【3줄 요약】, 【핵심 키워드】)을 정확히 지켜 텍스트로 답변하세요.', messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const text = (data.content?.[0]?.text||'').trim();
      return res.status(200).json({ summary: text });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // 알 수 없는 mode 방어
  return res.status(400).json({ error: `알 수 없는 mode: ${mode}` });
}
