const MODEL = 'gemini-3.1-flash-lite'; // ← 모델을 바꾸려면 이 한 줄만 고치면 된다

// 2027 냥운세 — Gemini 호출 서버리스 함수 (Vercel)
// - 사주팔자는 브라우저에서 만세력(lunar-javascript)으로 계산해서 보내 준다.
// - 이 함수는 계산된 사주를 검증하고, Gemini에게 "풀이"만 맡긴다.
// - API 키는 환경변수 GEMINI_API_KEY에서만 읽는다. 오류 문구에도 절대 넣지 않는다.
// - 생년월일 등 개인정보는 저장하거나 로그로 남기지 않는다.

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
const TIMEOUT_MS = 50000;

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const STEM_KO = { 甲: '갑', 乙: '을', 丙: '병', 丁: '정', 戊: '무', 己: '기', 庚: '경', 辛: '신', 壬: '임', 癸: '계' };
const BRANCH_KO = { 子: '자', 丑: '축', 寅: '인', 卯: '묘', 辰: '진', 巳: '사', 午: '오', 未: '미', 申: '신', 酉: '유', 戌: '술', 亥: '해' };
const ELEMENT = {
  甲: '목', 乙: '목', 丙: '화', 丁: '화', 戊: '토', 己: '토', 庚: '금', 辛: '금', 壬: '수', 癸: '수',
  寅: '목', 卯: '목', 巳: '화', 午: '화', 辰: '토', 戌: '토', 丑: '토', 未: '토', 申: '금', 酉: '금', 亥: '수', 子: '수',
};
const YINYANG = {
  甲: '양', 乙: '음', 丙: '양', 丁: '음', 戊: '양', 己: '음', 庚: '양', 辛: '음', 壬: '양', 癸: '음',
};

// 60갑자 목록 (입력 검증용)
const JIAZI = new Set(Array.from({ length: 60 }, (_, i) => STEMS[i % 10] + BRANCHES[i % 12]));

const SYSTEM_PROMPT = `너는 사주명리학에 밝은 운세 풀이가다.
사용자의 사주팔자는 이미 만세력으로 정확히 계산되어 주어진다. 절대 다시 계산하거나 바꾸지 말고 주어진 글자를 그대로 근거로 삼는다.
2027년은 정미년(丁未年)이다. 천간 丁은 음의 화(火), 지지 未는 음의 토(土)다.

풀이 원칙
- 일간(일주의 천간)을 중심으로 2027년 丁火·未土가 어떤 십신에 해당하는지, 원국의 오행 균형, 현재 대운을 근거로 구체적으로 풀이한다.
- 전문 용어는 꼭 필요할 때만 쓰고, 쓰면 바로 쉬운 말로 풀어 준다.
- 긍정적이되 현실적인 조언을 담는다. 겁주는 표현, 사고·사망 단정, 질병 진단, 특정 투자 종목 추천은 하지 않는다.
- 태어난 시간을 모르면 연주·월주·일주 세 기둥만으로 풀이하고, 시주를 지어내지 않는다.

출력 형식 (JSON)
- overall: 2027년 전체 흐름. 4~6문장 한 문단.
- fields.money(재물운), fields.love(연애운), fields.health(건강운), fields.work(직장·학업운): 각각 2~3문장.
- months: 양력 1월부터 12월까지 순서대로 정확히 12개. 각 항목은 한 문장(40자 안팎). "1월:" 같은 머리말 없이 내용만 쓴다.
- catWord: 고양이 점술사의 한마디. 1~2문장. 친근한 반말 고양이 말투로, 문장 끝을 "~냥"으로 맺는다. 이모지는 🐾 하나까지만.

말투 규칙 (매우 중요)
- overall, fields, months는 일반 존댓말(~합니다, ~예요)로 쓴다. 이 부분에는 "냥"을 절대 쓰지 않는다.
- catWord만 고양이 말투(~냥)로 쓴다.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overall: { type: 'STRING' },
    fields: {
      type: 'OBJECT',
      properties: {
        money: { type: 'STRING' },
        love: { type: 'STRING' },
        health: { type: 'STRING' },
        work: { type: 'STRING' },
      },
      required: ['money', 'love', 'health', 'work'],
      propertyOrdering: ['money', 'love', 'health', 'work'],
    },
    months: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 12, maxItems: 12 },
    catWord: { type: 'STRING' },
  },
  required: ['overall', 'fields', 'months', 'catWord'],
  propertyOrdering: ['overall', 'fields', 'months', 'catWord'],
};

// 오류 문구에서 API 키처럼 보이는 것을 모두 지운다.
function scrub(text, apiKey) {
  let s = String(text ?? '');
  if (apiKey) s = s.split(apiKey).join('[숨김]');
  s = s.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[숨김]');
  s = s.replace(/([?&]key=)[^&\s"']+/gi, '$1[숨김]');
  return s.slice(0, 600);
}

function sendError(res, httpStatus, code, status, message, apiKey) {
  res.status(httpStatus).json({
    error: {
      code: String(code ?? httpStatus),
      status: status ? String(status) : '',
      message: scrub(message, apiKey),
    },
  });
}

function pillarText(gz) {
  return `${gz}(${STEM_KO[gz[0]]}${BRANCH_KO[gz[1]]}) — 천간 ${gz[0]}: ${YINYANG[gz[0]]}의 ${ELEMENT[gz[0]]}, 지지 ${gz[1]}: ${ELEMENT[gz[1]]}`;
}

function buildUserPrompt({ pillars, timeKnown, gender, birthYear, daYun }) {
  const order = [
    ['연주', pillars.year],
    ['월주', pillars.month],
    ['일주', pillars.day],
  ];
  if (timeKnown) order.push(['시주', pillars.time]);

  const count = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 };
  for (const [, gz] of order) {
    count[ELEMENT[gz[0]]] += 1;
    count[ELEMENT[gz[1]]] += 1;
  }
  const dayStem = pillars.day[0];

  const lines = [
    '[사주 정보]',
    `성별: ${gender === 'male' ? '남성' : '여성'}`,
    `2027년 기준 나이: 약 ${2027 - birthYear}세 (${birthYear}년생)`,
    `태어난 시간: ${timeKnown ? '앎 (네 기둥)' : '모름 (시주 없이 세 기둥)'}`,
    ...order.map(([label, gz]) => `${label}: ${pillarText(gz)}`),
    `일간: ${dayStem}(${STEM_KO[dayStem]}) — ${YINYANG[dayStem]}의 ${ELEMENT[dayStem]}`,
    `오행 개수: 목 ${count.목}, 화 ${count.화}, 토 ${count.토}, 금 ${count.금}, 수 ${count.수}`,
    daYun
      ? `2027년이 속한 대운: ${daYun.ganZhi}(${STEM_KO[daYun.ganZhi[0]]}${BRANCH_KO[daYun.ganZhi[1]]}) 대운, ${daYun.startYear}~${daYun.endYear}년`
      : '2027년이 속한 대운: 정보 없음 (대운 시작 전이거나 계산 불가)',
    '',
    '[풀이할 해]',
    '2027년 정미년(丁未年)',
    '',
    '위 사주로 2027년 신년운세를 정해진 JSON 형식으로 풀이해 주세요.',
  ];
  return lines.join('\n');
}

function validate(body) {
  if (!body || typeof body !== 'object') return '요청 내용이 비어 있습니다.';
  const { pillars, timeKnown, gender, birthYear, daYun } = body;
  if (gender !== 'male' && gender !== 'female') return '성별 값이 올바르지 않습니다.';
  if (typeof timeKnown !== 'boolean') return '태어난 시간 정보가 올바르지 않습니다.';
  if (!Number.isInteger(birthYear) || birthYear < 1930 || birthYear > 2026) return '태어난 해가 올바르지 않습니다.';
  if (!pillars || typeof pillars !== 'object') return '사주 정보가 없습니다.';
  for (const k of ['year', 'month', 'day']) {
    if (!JIAZI.has(pillars[k])) return `사주 ${k} 값이 올바르지 않습니다.`;
  }
  if (timeKnown && !JIAZI.has(pillars.time)) return '시주 값이 올바르지 않습니다.';
  if (daYun != null) {
    if (typeof daYun !== 'object' || !JIAZI.has(daYun.ganZhi) ||
        !Number.isInteger(daYun.startYear) || !Number.isInteger(daYun.endYear)) {
      return '대운 정보가 올바르지 않습니다.';
    }
  }
  return null;
}

function cleanResult(obj) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const f = obj && typeof obj.fields === 'object' && obj.fields ? obj.fields : {};
  const months = Array.isArray(obj?.months) ? obj.months.map((m) => str(m).replace(/^\s*\d{1,2}\s*월\s*[:：\-–—]?\s*/, '')) : [];
  const result = {
    overall: str(obj?.overall),
    fields: { money: str(f.money), love: str(f.love), health: str(f.health), work: str(f.work) },
    months,
    catWord: str(obj?.catWord),
  };
  const missing = [];
  if (!result.overall) missing.push('총운');
  for (const [k, label] of [['money', '재물운'], ['love', '연애운'], ['health', '건강운'], ['work', '직장·학업운']]) {
    if (!result.fields[k]) missing.push(label);
  }
  if (months.length !== 12 || months.some((m) => !m)) missing.push(`월별 운세(받은 개수 ${months.length}개)`);
  if (!result.catWord) missing.push('고양이의 한마디');
  return { result, missing };
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 405, 'METHOD_NOT_ALLOWED', 'POST 요청만 받을 수 있습니다.');
  }

  if (!apiKey) {
    return sendError(res, 500, 'NO_API_KEY', 'SERVER_CONFIG',
      'GEMINI_API_KEY 환경변수가 설정되지 않았습니다. Vercel 프로젝트 설정 → Environment Variables에 추가한 뒤 다시 배포해 주세요.');
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const invalid = validate(body);
  if (invalid) return sendError(res, 400, 400, 'BAD_REQUEST', invalid, apiKey);

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(body) }] }],
    generationConfig: {
      temperature: 0.9,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let geminiRes;
  try {
    geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      return sendError(res, 504, 'TIMEOUT', 'DEADLINE_EXCEEDED', `Gemini가 ${TIMEOUT_MS / 1000}초 안에 답하지 않았습니다.`, apiKey);
    }
    return sendError(res, 502, 'NETWORK', 'FETCH_FAILED', `Gemini 서버에 연결하지 못했습니다: ${err?.message || err}`, apiKey);
  }
  clearTimeout(timer);

  const rawText = await geminiRes.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch { /* 아래에서 처리 */ }

  // Gemini가 오류를 돌려준 경우: 오류 번호와 메시지를 그대로(키만 지우고) 화면으로 보낸다.
  if (!geminiRes.ok) {
    const e = data?.error || {};
    return sendError(
      res,
      geminiRes.status,
      e.code ?? geminiRes.status,
      e.status || geminiRes.statusText,
      e.message || rawText || '알 수 없는 오류',
      apiKey,
    );
  }

  if (!data) {
    return sendError(res, 502, 'BAD_GEMINI_RESPONSE', 'PARSE_ERROR', 'Gemini 응답을 JSON으로 읽지 못했습니다.', apiKey);
  }

  if (data.promptFeedback?.blockReason) {
    return sendError(res, 502, 'BLOCKED', data.promptFeedback.blockReason,
      `Gemini가 요청을 차단했습니다 (${data.promptFeedback.blockReason}).`, apiKey);
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) {
    return sendError(res, 502, 'EMPTY_RESPONSE', candidate?.finishReason || 'NO_CANDIDATE',
      `Gemini가 빈 답을 돌려줬습니다 (finishReason: ${candidate?.finishReason || '없음'}).`, apiKey);
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return sendError(res, 502, 'BAD_JSON', candidate?.finishReason || 'PARSE_ERROR',
      `Gemini가 돌려준 풀이를 JSON으로 읽지 못했습니다 (finishReason: ${candidate?.finishReason || '없음'}).`, apiKey);
  }

  const { result, missing } = cleanResult(parsed);
  if (missing.length) {
    return sendError(res, 502, 'INCOMPLETE', 'MISSING_FIELDS', `풀이에 빠진 부분이 있습니다: ${missing.join(', ')}`, apiKey);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
};
