const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// JSON 추출 헬퍼 — greedy match 방지: 마지막 }를 기준으로 가장 바깥 객체 추출
function extractJSON(raw) {
  // 1차: 직접 파싱 시도
  try { return JSON.parse(raw); } catch(_) {}
  // 2차: 첫 { ~ 마지막 } 슬라이스
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('JSON 없음: ' + raw.slice(0, 120));
  try { return JSON.parse(raw.slice(start, end + 1)); } catch(e) {
    throw new Error('JSON 파싱 실패: ' + e.message + ' / 원문: ' + raw.slice(start, start + 120));
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
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:400, system:'당신은 JSON만 출력하는 도구입니다. 마크다운 없이 순수 JSON만 반환하세요.', messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      // { } 사이 JSON만 추출 — 마크다운/텍스트 섞여도 안전
      const parsed = extractJSON(raw);
      try { await kv.set(cacheKey, parsed, { ex: 86400 }); } catch(e) {}
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
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:800, system:'당신은 JSON만 출력하는 도구입니다. 마크다운 없이 순수 JSON만 반환하세요.', messages:[{role:'user',content:prompt}] })
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
    const usedScripts  = Array.isArray(req.body.usedScripts) ? req.body.usedScripts : [];
    const weaknessTip  = typeof req.body.weaknessTip === 'string' ? req.body.weaknessTip.slice(0,80) : '';
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
- 등장인물 2~3명, 대사 12~16줄, 지문 5~7개
- 실제 방영 드라마 수준의 자연스러운 한국어${usedInfo}${weaknessTip ? '\n\n[이번 씬 집중 포인트] ' + weaknessTip : ''}

응답 형식 (JSON만):
{"script":{"sceneNum":"S#7","setting":"회사 복도 - 낮","characters":["민준","서아"],"script":"S#7. 회사 복도 - 낮\n(퇴근 시간. 텅 빈 복도. 형광등 하나가 깜빡인다. 민준이 코트를 들고 나오다 멈춘다.)\n서아: (뒤에서, 낮게) 민준씨.\n민준: (걸음을 멈추지만 돌아보지 않는다)\n서아: 오 분만요. 딱 오 분.\n민준: (천천히 돌아서며) 오 분.\n(서아가 한 발짝 다가선다. 민준이 반 발짝 물러선다. 둘 다 그 사실을 안다.)\n서아: 내가 틀렸어요. 그때.\n민준: (작게 웃으며) 알아요.\n서아: 그럼—\n민준: 알면서 기다렸어요. 일 년을.\n(서아가 말을 잃는다. 민준이 코트를 입는다. 천천히, 단추 하나하나.)\n민준: 오 분 됐어요.\n(민준이 걸어간다. 서아는 그 자리에 서서 형광등을 본다. 여전히 깜빡인다.)"}}
`; 

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({model:'claude-haiku-4-5', max_tokens:900, system:'당신은 JSON만 출력하는 드라마 작가입니다. 마크다운 없이 순수 JSON만 반환하세요.', messages:[{role:'user',content:prompt}]})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      const parsed = extractJSON(raw);
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
  if (mode === 'dailyRef') {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `dailyRef:${today}`;
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return res.status(200).json(cached);
    } catch(e) {}

    // 참고 가능한 작품 풀 (저작권 무관 — 구조/패턴 분석용)
    const WORKS = [
      // ── 미장센·롱테이크 ──
      {
        title: '나의 아저씨', ep: '4화', genre: '멜로드라마',
        scene: '이지안이 동훈의 통화를 몰래 들으며 처음으로 무너지는 씬',
        directionFocus: '롱테이크·정적 미장센 — 대사 없이 인물의 감정 변화를 공간과 침묵으로 전달하는 방식'
      },
      {
        title: '미스터 션샤인', ep: '7화', genre: '사극멜로',
        scene: '고애신이 저격 총구 뒤에서 유진을 처음으로 마주치는 씬',
        directionFocus: '서정적 롱샷 — 역사의 무게와 인물의 감정을 원거리 구도로 담아내는 방식'
      },
      {
        title: 'SKY캐슬', ep: '10화', genre: '심리스릴러',
        scene: '김주영이 강예서를 처음으로 심리적으로 압박하는 씬',
        directionFocus: '공간 미장센 — 실내 공간 배치와 인물 위치로 권력 관계를 시각화하는 방식'
      },
      {
        title: '파친코', ep: '2화', genre: '가족사극',
        scene: '선자와 이삭이 처음으로 서로의 진심을 나누는 씬',
        directionFocus: '색감 설계 — 시대별 색온도 차이로 주제와 감정선을 영상 언어로 표현하는 방식'
      },
      {
        title: '무브 투 헤븐', ep: '1화', genre: '가족드라마',
        scene: '그루가 유품을 정리하다 고인의 마지막 이야기를 발견하는 씬',
        directionFocus: '오브제 연출 — 소품과 유품이 대사를 대신해 인물의 내면을 전달하는 방식'
      },
      {
        title: '작은 아씨들', ep: '3화', genre: '심리스릴러',
        scene: '오인주가 처음으로 상류층의 공간에 들어서며 이질감을 느끼는 씬',
        directionFocus: '계층 시각화 — 공간 크기·색채·조명으로 계층 차이를 감각적으로 표현하는 방식'
      },
      // ── 편집·리듬 ──
      {
        title: '비밀의 숲', ep: '5화', genre: '범죄수사',
        scene: '황시목이 한여진과 처음으로 신뢰를 구축하는 씬',
        directionFocus: '감정 배제 편집 — 표정·감정 없이 행동과 정보만으로 긴장을 쌓아가는 편집 방식'
      },
      {
        title: '시그널', ep: '3화', genre: '스릴러',
        scene: '과거와 현재가 무전으로 처음 연결되며 사건의 실마리가 드러나는 씬',
        directionFocus: '시공간 교차편집 — 두 시간대를 리듬감 있게 교차해 긴장과 감정을 동시에 구축하는 방식'
      },
      {
        title: '킹덤', ep: '1화', genre: '사극스릴러',
        scene: '세자가 처음으로 좀비의 존재를 목격하는 씬',
        directionFocus: '장르 혼합 편집 — 사극의 느린 호흡과 공포의 빠른 컷을 충돌시켜 충격을 극대화하는 방식'
      },
      {
        title: '뿌리깊은 나무', ep: '6화', genre: '사극스릴러',
        scene: '채윤이 범인의 정체에 한 발짝 다가서는 씬',
        directionFocus: '긴장 편집 리듬 — 사극에서 정보 공개 타이밍과 컷 간격으로 서스펜스를 만드는 방식'
      },
      {
        title: '오징어 게임', ep: '1화', genre: '스릴러',
        scene: '참가자들이 게임의 실체를 처음 마주하는 씬',
        directionFocus: '색채 상징 — 원색 배경과 인물 의상 색으로 주제 의식과 권력 구도를 시각화하는 방식'
      },
      {
        title: '지옥', ep: '1화', genre: '사회스릴러',
        scene: '첫 번째 지옥행 고지가 실제로 일어나는 씬',
        directionFocus: '장르 전환 편집 — 일상 분위기에서 공포로 전환하는 시점의 컷 충격을 설계하는 방식'
      },
      // ── 공간·시점 ──
      {
        title: '미생', ep: '8화', genre: '직장드라마',
        scene: '장그래가 오차장에게 처음으로 인정을 받는 씬',
        directionFocus: '공간 권력 표현 — 사무실 공간 구조와 카메라 높이로 직장 내 위계를 시각화하는 방식'
      },
      {
        title: '이상한 변호사 우영우', ep: '4화', genre: '법정드라마',
        scene: '우영우가 법정에서 처음으로 역전 논리를 펼치는 씬',
        directionFocus: '시점 카메라 — 주인공의 독특한 세계관을 카메라 앵글과 시선 처리로 표현하는 방식'
      },
      {
        title: '정신병동에도 아침이 와요', ep: '2화', genre: '의학드라마',
        scene: '다은이 처음으로 환자의 감정에 압도되는 씬',
        directionFocus: '공간 구도로 내면 표현 — 병동 공간의 구도와 여백으로 인물의 심리 상태를 시각화하는 방식'
      },
      {
        title: '비밀의 숲2', ep: '7화', genre: '범죄수사',
        scene: '황시목과 한여진이 서로 다른 편임을 확인하는 씬',
        directionFocus: '물리적 거리 연출 — 두 인물 사이의 공간 거리로 심리적 균열을 표현하는 방식'
      },
      // ── 감정·앙상블 ──
      {
        title: '동백꽃 필 무렵', ep: '6화', genre: '로맨스',
        scene: '까불이가 동백에게 고백을 돌려서 하는 씬',
        directionFocus: '일상 공간의 감정화 — 평범한 카페 공간을 조명과 거리감으로 감정 공간으로 전환하는 방식'
      },
      {
        title: '슬기로운 의사생활', ep: '3화', genre: '의학드라마',
        scene: '다섯 친구가 수술 후 옥상에서 맥주를 마시는 씬',
        directionFocus: '앙상블 편집 — 여러 인물의 감정을 동시에 균형 있게 담는 다중 인물 편집 방식'
      },
      {
        title: '응답하라 1988', ep: '7화', genre: '청춘가족',
        scene: '골목 이웃들이 함께 저녁을 먹는 일상 씬',
        directionFocus: '공동체 공간 연출 — 좁은 골목을 따뜻한 색감과 앵글로 공동체 감정을 담아내는 방식'
      },
      {
        title: '스물다섯 스물하나', ep: '9화', genre: '청춘로맨스',
        scene: '백이진과 나희도가 새벽 빈 펜싱장에서 대화하는 씬',
        directionFocus: '핸드헬드 — 흔들리는 카메라로 청춘의 불안과 에너지를 날것으로 표현하는 방식'
      },
      {
        title: '눈물의 여왕', ep: '12화', genre: '멜로드라마',
        scene: '현우가 마지막이라 생각하고 해인에게 진심을 털어놓는 씬',
        directionFocus: '클로즈업 타이밍 — 감정 절정의 순간을 클로즈업으로 전환하는 타이밍 설계'
      },
      {
        title: '갯마을 차차차', ep: '5화', genre: '로맨스',
        scene: '혜진이 두식의 과거를 우연히 알게 되는 씬',
        directionFocus: '로케이션 연출 — 바다·자연 공간을 인물의 감정 상태와 연결해 배경이 감정을 말하게 하는 방식'
      },
      {
        title: '이태원 클라쓰', ep: '4화', genre: '청춘드라마',
        scene: '박새로이가 장가에게 절대 지지 않겠다 선언하는 씬',
        directionFocus: '대립 구도 화면화 — 두 인물의 힘 관계를 카메라 높이·거리·구도로 시각화하는 방식'
      },
      {
        title: '마이 디어 미스터', ep: '6화', genre: '멜로드라마',
        scene: '지안이 혼자 버스 안에서 동훈의 목소리를 듣고 처음 감정이 흔들리는 씬',
        directionFocus: '침묵과 음향 대비 — 도시 소음 속 고요함으로 인물 내면의 변화를 청각적으로 설계하는 방식'
      },
      // ── 추가 작품 ──
      {
        title: '괴물', ep: '6화', genre: '범죄스릴러',
        scene: '두 형사가 서로를 의심하면서도 협력해야 하는 상황에서 대치하는 씬',
        directionFocus: '심리 역전 편집 — 두 인물이 같은 공간에서 서로 다른 정보를 가진 채 대화할 때 컷 타이밍으로 긴장을 조절하는 방식'
      },
      {
        title: '마우스', ep: '4화', genre: '범죄스릴러',
        scene: '주인공이 자신의 정체성에 처음으로 의문을 품는 씬',
        directionFocus: '시점 혼란 연출 — 주관적 시점과 객관적 시점을 교차해 관객과 인물이 동시에 혼란을 경험하게 만드는 방식'
      },
      {
        title: '손 the guest', ep: '5화', genre: '오컬트스릴러',
        scene: '세 주인공이 각자의 장소에서 같은 존재를 동시에 감지하는 씬',
        directionFocus: '공간 분할 편집 — 서로 다른 공간의 세 인물을 리듬감 있게 연결해 하나의 공포를 공유하게 만드는 방식'
      },
      {
        title: '아무도 모른다', ep: '3화', genre: '미스터리',
        scene: '차영진이 실종 아이의 흔적을 발견하며 사건의 실마리를 잡는 씬',
        directionFocus: '디테일 클로즈업 — 소품과 환경의 작은 디테일을 클로즈업으로 포착해 관객이 단서를 인식하게 유도하는 방식'
      },
      {
        title: '밀회', ep: '8화', genre: '멜로드라마',
        scene: '오혜원이 이선재의 피아노 연주를 처음으로 혼자 듣는 씬',
        directionFocus: '음악과 시선 연출 — 클래식 음악의 흐름을 따라 카메라가 인물의 감정 변화를 포착하는 방식'
      },
      {
        title: '마더', ep: '4화', genre: '사회드라마',
        scene: '수진이 아이를 데리고 처음으로 도망치기로 결심하는 씬',
        directionFocus: '행동 결심의 시각화 — 내면의 결심을 대사 없이 시선과 신체 움직임만으로 표현하는 방식'
      },
      {
        title: '눈이 부시게', ep: '5화', genre: '판타지멜로',
        scene: '혜자가 젊은 시절과 현재 사이에서 현실을 인식하는 씬',
        directionFocus: '시간 중첩 연출 — 과거와 현재의 같은 공간을 오버랩으로 연결해 시간의 감각을 흐리는 방식'
      },
      {
        title: '우리들의 블루스', ep: '7화', genre: '옴니버스드라마',
        scene: '동석과 은희가 오랜 감정을 처음으로 직면하는 씬',
        directionFocus: '제주 공간 활용 — 바다·바람 등 자연 환경을 인물의 감정 상태와 연결해 배경이 감정을 증폭시키는 방식'
      },
      {
        title: '보건교사 안은영', ep: '2화', genre: '판타지',
        scene: '안은영이 젤리를 처리하면서 학교의 이면을 처음 직면하는 씬',
        directionFocus: '현실-판타지 병치 — 동일 공간에서 현실 화면과 판타지 화면을 자연스럽게 전환하는 시각 설계'
      },
      {
        title: '얼렁뚱땅 흥신소', ep: '3화', genre: '코미디드라마',
        scene: '두 주인공이 의뢰를 해결하다 예상치 못한 감정에 맞닥뜨리는 씬',
        directionFocus: '코미디-감정 전환 편집 — 웃음과 감동의 전환 타이밍을 컷 간격으로 조절하는 방식'
      },
      {
        title: '인간수업', ep: '4화', genre: '청소년스릴러',
        scene: '지수가 처음으로 자신이 만든 상황의 통제력을 잃기 시작하는 씬',
        directionFocus: '속도 편집 — 사건이 통제 불능으로 가는 심리를 편집 템포 가속으로 시각화하는 방식'
      },
      {
        title: '디피 (D.P.)', ep: '3화', genre: '사회드라마',
        scene: '준호가 탈영병의 사연을 처음으로 이해하게 되는 씬',
        directionFocus: '공감 시점 전환 — 추격자의 시점에서 도망자의 시점으로 카메라가 이동해 감정 이입을 유도하는 방식'
      },
      {
        title: '그 해 우리는', ep: '6화', genre: '로맨스',
        scene: '웅과 연수가 다큐 촬영 중 카메라 앞에서 처음으로 솔직해지는 씬',
        directionFocus: '카메라 안의 카메라 — 극 중 다큐 카메라를 통해 인물의 민낯을 보여주는 메타 연출 방식'
      },
      {
        title: '멜로가 체질', ep: '5화', genre: '로맨틱코미디',
        scene: '세 친구가 각자의 감정을 숨긴 채 같은 공간에서 대화하는 씬',
        directionFocus: '앙상블 감정 편집 — 세 인물이 각자 다른 감정 상태일 때 리액션 컷으로 코미디와 감정을 동시에 살리는 방식'
      },
      {
        title: '봄밤', ep: '8화', genre: '멜로드라마',
        scene: '지호가 정인에게 처음으로 솔직하게 자신의 상황을 털어놓는 씬',
        directionFocus: '야간 자연광 연출 — 인공 조명 없이 밤의 자연광만으로 인물의 취약함과 진정성을 표현하는 방식'
      },
      {
        title: '추노', ep: '6화', genre: '사극액션',
        scene: '대길과 언년이 재회하지만 말 한마디 못하고 엇갈리는 씬',
        directionFocus: '슬로우모션 감정 — 감정의 절정을 슬로우모션과 음악으로 시간을 늘려 여운을 극대화하는 방식'
      },
      {
        title: '옷소매 붉은 끝동', ep: '9화', genre: '사극로맨스',
        scene: '덕임과 세손이 서로의 마음을 알면서도 체면 때문에 다른 말을 하는 씬',
        directionFocus: '사극 절제 연출 — 감정을 직접 표현하지 않고 눈빛·손·소품으로만 전달하는 절제된 표현 방식'
      },
      {
        title: '연애시대', ep: '4화', genre: '멜로드라마',
        scene: '돈과 은호가 이혼 후에도 서로를 놓지 못하는 감정을 확인하는 씬',
        directionFocus: '공간 반복 연출 — 같은 장소를 다른 감정 상태로 재방문해 시간의 흐름과 감정 변화를 대비시키는 방식'
      },
      {
        title: '질투의 화신', ep: '10화', genre: '로맨틱코미디',
        scene: '화신이 자신의 감정을 인정하지 않으려다 결국 폭발하는 씬',
        directionFocus: '감정 억제-폭발 리듬 — 눌러놓은 감정이 한계에 달하는 순간을 편집 속도 변화로 시각화하는 방식'
      },
      {
        title: '로맨스가 필요해 2012', ep: '5화', genre: '로맨틱코미디',
        scene: '주인공이 현실적인 연애와 이상적인 연애 사이에서 갈등하는 씬',
        directionFocus: '내레이션-화면 대비 — 인물의 속마음 내레이션과 실제 행동이 정반대일 때 두 레이어를 동시에 보여주는 방식'
      },
      {
        title: '오월의 청춘', ep: '3화', genre: '사극멜로',
        scene: '희태가 명희를 지켜보면서 시대의 무게와 개인의 감정 사이에서 흔들리는 씬',
        directionFocus: '역사적 공간 연출 — 시대적 배경 공간을 인물의 감정 상태와 연결해 개인사와 역사가 충돌하는 순간을 시각화하는 방식'
      },
    ];

    // 날짜 기반 고정 선택 (매일 다른 작품)
    const dayNum = Math.floor(new Date(today).getTime() / 86400000);
    const work = WORKS[dayNum % WORKS.length];

    const prompt = `당신은 한국 드라마 연출 분석 전문가입니다.
아래 씬의 구조와 연출 방식을 분석하고, 같은 패턴으로 오리지널 씬을 창작하세요.

참고 작품: ${work.title} ${work.ep} — ${work.scene} (${work.genre})
핵심 연출 포인트: ${work.directionFocus}

분석 항목:
1. 씬 구조 패턴: 이 씬의 극적 구조와 위 연출 포인트가 어떻게 맞물리는지 (2~3문장)
2. 핵심 연출 기법 3가지: 카메라워크 / 편집 리듬 / 미장센 각 1줄씩 구체적으로
3. 대사 전략: 대사가 감정을 어떻게 숨기거나 드러내는지, 침묵·행동과의 관계 (2문장)

오리지널 씬 창작 (위 패턴 적용):
- 같은 극적 구조와 연출 기법을 사용하되 완전히 다른 인물·상황
- 씬 헤더: S#숫자. 장소 - 시간대
- 지문: (소괄호), 대사: 인물명: 대사
- 등장인물 2~3명, 대사 12~16줄, 지문 5~7개

순수 JSON만 출력하세요. 마크다운, 코드블록, 추가 텍스트 없이:
{"ref":{"title":"작품명","ep":"화수","scene":"씬설명","genre":"장르","structurePattern":"구조패턴","techniques":["기법1","기법2","기법3"],"dialogueStrategy":"대사전략"},"script":{"sceneNum":"S#1","setting":"장소-시간","characters":["인물1","인물2"],"script":"대본전체"}}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1200,
          system: '당신은 JSON만 출력하는 드라마 분석 도구입니다. 반드시 순수 JSON만 반환하고 마크다운 코드블록이나 추가 텍스트를 절대 포함하지 마세요.',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text || '').trim();
      const parsed = extractJSON(raw);
      // 24시간 캐싱
      try { await kv.set(cacheKey, parsed, { ex: 86400 }); } catch(e) {}
      return res.status(200).json(parsed);
    } catch(e) {
      console.error('[dailyRef] 오류:', e.message);
      return res.status(500).json({ error: '참고 작품 생성 실패: ' + e.message });
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
        body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:400, system:'당신은 JSON만 출력하는 도구입니다. 마크다운 없이 순수 JSON만 반환하세요.', messages:[{role:'user',content:prompt}] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
      const raw = (data.content?.[0]?.text||'').trim();
      // { } 사이 JSON만 추출 — 마크다운/텍스트 섞여도 안전
      const parsed = extractJSON(raw);
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
      body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:500, system:'당신은 JSON만 출력하는 도구입니다. 마크다운 없이 순수 JSON만 반환하세요.', messages:[{role:'user',content:prompt}] })
    });
    const data = await response.json();
      if (!response.ok) throw new Error(`Anthropic API 오류 (${response.status}): ${data.error?.message || response.statusText}`);
    const text = (data.content?.[0]?.text||'').trim();
    return res.status(200).json({ summary: text });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
