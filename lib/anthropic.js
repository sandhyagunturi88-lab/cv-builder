'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// Thrown when the model declines a request (stop_reason: "refusal") or
// truncates its response at the token cap (stop_reason: "max_tokens").
// server.js catches these by type and maps them to a clean 502 with no
// partial model text leaked, instead of the generic catch-all.
class ModelRefusalError extends Error {}
class ModelTruncatedError extends Error {}

// Every call helper runs its response through this before reading content.
function checkStopReason(response) {
  if (response.stop_reason === 'refusal') {
    throw new ModelRefusalError('The model declined this request.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ModelTruncatedError('The model response was truncated at the token limit.');
  }
}

// JobPilot convention: claude-opus-5 default, ANTHROPIC_MODEL to override.
// No route uses this anymore -- tailorToJob/diagnoseCV/keywordGap (formerly
// out of scope for the cost refactor) now use the tiered MODEL_* constants
// below, same as generateCV/suggestIdeas/polishEntry/extractCV; interviewTurn
// uses its own INTERVIEW_MODEL. Left in place (unused) rather than removed,
// so ANTHROPIC_MODEL doesn't silently become an unrecognized env var for
// existing deployments, and still exported in case anything external reads
// it -- see IMPLEMENTATION.md for the full note.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
// Opus 5 thinks by default and max_tokens caps thinking + response text, so
// every cap below carries generous headroom (you pay for tokens produced,
// not for the cap).
const MAX_TOKENS = 16000;

// Cost-tiered model config for the four in-scope AI routes. Each is
// independently env-overridable so ops can dial cost/quality per route
// without a redeploy.
// - generateCV: full CV generation quality needs the strongest model.
const MODEL_GENERATE = process.env.MODEL_GENERATE || 'claude-opus-5';
// - suggestIdeas/polishEntry: short, mechanical rewrites -- a mid-tier model
//   at low effort is plenty.
const MODEL_LIGHT = process.env.MODEL_LIGHT || 'claude-sonnet-5';
// - extractCV: structured field extraction from an uploaded CV is cheap,
//   mechanical work -- route it to the cheapest model. claude-haiku-4-5 does
//   not support the effort/thinking parameters, so extractCV sends neither.
const MODEL_EXTRACT = process.env.MODEL_EXTRACT || 'claude-haiku-4-5';

const SYSTEM_PROMPT =
  'You are a UK careers adviser. Rewrite the CV facts supplied into a one-page ' +
  'UK-format CV. Use ONLY supplied facts; items marked NONE are omitted, never ' +
  'invented. No photo, DOB, or full address. Every bullet starts with an active ' +
  'verb. Where the supplied facts support it, shape experience and project bullets ' +
  'as accomplishment + measurable result + method (the XYZ formula: "Accomplished ' +
  'X, as measured by Y, by doing Z"), keeping the sentence natural. Never invent ' +
  'a number for the measure — if none was supplied, write the bullet without one. ' +
  'Banned words: leveraged, synergy, passionate, dynamic, results-driven, ' +
  'spearheaded.\n\n' +
  'FORMAT — follow exactly, the output is machine-parsed:\n' +
  '- Return the CV as Markdown.\n' +
  '- First line: the candidate\'s name as a level-1 heading ("# Name").\n' +
  '- Second line: contact details on one line, separated by " | ".\n' +
  '- Every CV section as a level-2 heading ("## Section Name") followed by short ' +
  'paragraphs or "- " bullets.\n' +
  '- Section order: Profile, Education, Projects, Experience, Skills, and Interests ' +
  'LAST (UK convention) — omitting any section with no supplied facts.\n' +
  '- No tables, blockquotes, code fences, or horizontal rules inside the CV.\n\n' +
  'After the CV, output a line containing only "---", then a "## Feedback" section with:\n' +
  '- Short "- " bullets naming the weakest sections and why.\n' +
  '- Then the exact heading "### Three actions for the next six months to create public ' +
  'evidence" followed by exactly 3 "- " bullets tailored to the stated target role. Each ' +
  'bullet: a bold imperative sentence naming the action ("**Do X.**"), then an achievability ' +
  'tag in square brackets — [Quick win], [Likely], or [Stretch] — then 1-3 sentences ' +
  'explaining why this strengthens THIS CV for THIS target role, referencing the supplied facts.';

const SUGGEST_MAX_TOKENS = 8000;

// Suggestions must never hand the student ready-made claims — each one is a
// question about what they may already have done, or a small real action.
const SUGGEST_PROMPT =
  'You are a UK careers adviser helping a school leaver fill in the projects/' +
  'activities step of a CV builder. From the context supplied (target role, ' +
  'subjects, entries so far), suggest what they could add to this step.\n\n' +
  'STRICT RULES:\n' +
  '- Never invent facts or write ready-made CV lines to paste in.\n' +
  '- Phrase every suggestion either as a question about what they may already ' +
  'have done ("Did you…?") or as a small concrete action completable within a ' +
  'few weeks ("Enter…", "Build…", "Ask to…").\n' +
  '- Tailor every suggestion to the target role; do not repeat things already listed.\n' +
  '- Return 4-6 short "- " bullets only — no headings, no preamble, no closing note.\n' +
  '- Banned words: leveraged, synergy, passionate, dynamic, results-driven, spearheaded.';

const POLISH_MAX_TOKENS = 8000;

// Turns a rough, true note from the student into one CV-ready entry for a
// chosen field. Rephrasing only — it must never add facts they didn't state.
const POLISH_PROMPT =
  'You are a UK careers adviser. The student sends a rough, true note about ' +
  'something they did, the CV field it belongs to, and their target role. ' +
  'Rewrite it as one concise, CV-ready entry for that field, in UK English, ' +
  'starting with an active verb and worded to suit the target role.\n\n' +
  'STRICT RULES:\n' +
  '- Use ONLY facts present in the note — never add numbers, dates, tools, ' +
  'organisations or outcomes they did not state.\n' +
  '- Where the note supports it, shape the entry as accomplishment + measurable ' +
  'result + method (the XYZ formula: "Accomplished X, as measured by Y, by doing ' +
  'Z"). If no measurable result was stated, mark where one belongs with a ' +
  'placeholder like [number of customers] — never invent one. Skip the formula ' +
  'where it does not fit the field (e.g. an interest or sport).\n' +
  '- If a strengthening detail is missing, mark where it goes with a ' +
  '[square-bracket placeholder] such as [year] or [number of customers].\n' +
  '- Banned words: leveraged, synergy, passionate, dynamic, results-driven, spearheaded.\n\n' +
  'OUTPUT — the response schema enforces the exact shape, so just populate it:\n' +
  '- field "project": "title" is a short project name; "desc" is one or two ' +
  'short sentences describing what was done and with what\n' +
  '- field "job": "role" is the job title, "org" the organisation, "dates" the ' +
  'dates, "desc" one or two short sentences of what they did — use ' +
  '[placeholders] for role, org or dates if not stated\n' +
  '- any other field ("achievement", "skill", "responsibility", "sport", "award", ' +
  '"interest"): "text" is the single line';

// JSON Schema for polishEntry's structured output, keyed on the category the
// caller already knows (see POLISH_CATEGORIES in server.js) rather than one
// giant oneOf union. additionalProperties:false + required on every object;
// no length/range constraints (the API does not support them).
function polishSchema(category) {
  if (category === 'project') {
    return {
      type: 'object',
      properties: {
        title: { type: 'string' },
        desc: { type: 'string' },
      },
      required: ['title', 'desc'],
      additionalProperties: false,
    };
  }
  if (category === 'job') {
    return {
      type: 'object',
      properties: {
        role: { type: 'string' },
        org: { type: 'string' },
        dates: { type: 'string' },
        desc: { type: 'string' },
      },
      required: ['role', 'org', 'dates', 'desc'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  };
}

const TAILOR_MAX_TOKENS = 8000;

// Tailors the profile summary and skills ordering to a specific job advert.
// Matching only — the advert never adds facts to the CV; requirements the
// candidate can't evidence come back as honest "missing" gaps instead.
const TAILOR_PROMPT =
  'You are a UK careers adviser. The student sends a job advert and the true ' +
  'facts from their CV. Tailor their CV to this advert.\n\n' +
  'STRICT RULES:\n' +
  '- Use ONLY skills, subjects and experience present in the CV facts — never ' +
  'claim something just because the advert asks for it.\n' +
  '- "summary": rewrite the profile summary as 2-3 sentences of UK English ' +
  '(no "I") that speak to THIS advert — name the role, and lead with the ' +
  'candidate\'s most relevant true evidence.\n' +
  '- "skills": the candidate\'s stated skills as one comma-separated line, ' +
  'reordered with the most relevant to the advert first. Keep every skill ' +
  'they stated; add none.\n' +
  '- "matched": 3-8 short requirements from the advert the candidate can ' +
  'genuinely evidence, each as "requirement — their evidence".\n' +
  '- "missing": up to 5 short requirements from the advert with no evidence ' +
  'in the CV facts — honest gaps to know about before applying, never to fake.\n' +
  '- Banned words: leveraged, synergy, passionate, dynamic, results-driven, ' +
  'spearheaded.\n\n' +
  'OUTPUT — the response schema enforces the exact fields; populate "summary", ' +
  '"skills", and "matched"/"missing" as arrays of strings in the format described above.';

// JSON Schema for tailorToJob's structured output. additionalProperties:false
// + required on every object; no length/range constraints (the API does not
// support them).
const TAILOR_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    skills: { type: 'string' },
    matched: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'skills', 'matched', 'missing'],
  additionalProperties: false,
};

// Interviews are ~8 calls per session, so they run on Sonnet by default to
// keep the per-session cost sane; INTERVIEW_MODEL overrides (e.g. back to
// claude-opus-5, or down further).
const INTERVIEW_MODEL = process.env.INTERVIEW_MODEL || 'claude-sonnet-5';
const INTERVIEW_MAX_TOKENS = 8000;

const INTERVIEW_PROMPT =
  'You are a friendly but rigorous UK hiring manager interviewing a school ' +
  'leaver for the target role. Their true CV facts (and the job advert, when ' +
  'given) are supplied. The facts may include a "STAGE: …" line — calibrate ' +
  'question difficulty and tone to it (e.g. a Year 11 GCSE candidate vs. a ' +
  'Year 13 A-level/college candidate). Run a realistic first-job interview:\n' +
  '- Ask ONE question at a time, 6-8 questions in total, then finish.\n' +
  '- Mix question types: motivation for THIS role, CV-specific ("You mention ' +
  'X — tell me more"), competency ("Tell me about a time…"), and 1-2 simple ' +
  'role-relevant technical or aptitude questions.\n' +
  '- Ground every CV-specific question in the supplied facts — never invent ' +
  'details about the candidate.\n' +
  '- After each answer, rate it 1-10 and give 2-3 sentences of feedback: what ' +
  'was good, then what a stronger answer would include. Encouraging tone — ' +
  'this may be their first ever interview practice.\n' +
  '- On the opening turn (no answers yet) ask the first question with ' +
  '"rating" and "feedback" as null.\n' +
  '- UK English. Banned words: leveraged, synergy, passionate, dynamic, ' +
  'results-driven, spearheaded.\n\n' +
  'OUTPUT — the response schema enforces the exact fields.\n' +
  'Every turn except the last: rating 1-10 or null, feedback a string or null, ' +
  'done false, next_question the next question.\n' +
  'The final turn: rating 1-10, feedback a string, done true, next_question null, ' +
  'summary with overall 1-10, strengths, and work_on (three items).';

// JSON Schema for interviewTurn's structured output: a discriminated union on
// "done" (anyOf + const — supported by the API; oneOf/nullable-type-array are
// not confirmed and avoided). The non-final branch covers the opening turn
// too, where rating/feedback are null. additionalProperties:false + required
// on every object; no length/range constraints (the API does not support
// them).
const INTERVIEW_TURN_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: {
        rating: { anyOf: [{ type: 'null' }, { type: 'integer' }] },
        feedback: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        done: { const: false },
        next_question: { type: 'string' },
      },
      required: ['rating', 'feedback', 'done', 'next_question'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        rating: { type: 'integer' },
        feedback: { type: 'string' },
        done: { const: true },
        next_question: { type: 'null' },
        summary: {
          type: 'object',
          properties: {
            overall: { type: 'integer' },
            strengths: { type: 'array', items: { type: 'string' } },
            work_on: { type: 'array', items: { type: 'string' } },
          },
          required: ['overall', 'strengths', 'work_on'],
          additionalProperties: false,
        },
      },
      required: ['rating', 'feedback', 'done', 'next_question', 'summary'],
      additionalProperties: false,
    },
  ],
};

const KEYWORD_GAP_EXTRACT_MAX_TOKENS = 8000;

// Step 1 of the keyword-gap restructure (cost refactor): extracts the
// in-demand skills/requirements from a role's advert corpus ONCE, cached
// server-side per role for 24h (see server.js) -- this is the ~90K-char-per-
// call cost this refactor targets. Runs on MODEL_EXTRACT (Haiku): mechanical
// frequency extraction, no per-user judgment.
const KEYWORD_GAP_EXTRACT_PROMPT =
  'You are a UK careers adviser. The user sends a target role and a corpus of ' +
  'real UK job adverts for that role. Work out what employers actually ask for.\n\n' +
  'STRICT RULES:\n' +
  '- "in_demand": the ~10 skills or requirements asked for most often across ' +
  'the adverts, most frequent first, each with the number of adverts asking ' +
  'for it.\n' +
  '- Base this ONLY on the supplied adverts — do not draw on outside knowledge ' +
  'of the role.\n\n' +
  'OUTPUT — the response schema enforces the exact fields; populate "in_demand" ' +
  'as described above.';

const KEYWORD_GAP_EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    in_demand: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          seen_in: { type: 'integer' },
        },
        required: ['keyword', 'seen_in'],
        additionalProperties: false,
      },
    },
  },
  required: ['in_demand'],
  additionalProperties: false,
};

const KEYWORD_GAP_DIFF_MAX_TOKENS = 8000;

// Step 2 of the keyword-gap restructure: diffs ONE user's CV facts against
// the (possibly cached) in-demand list from step 1. Runs on every request
// (cache hit or miss), since matched/missing depend on this specific user's
// facts. Runs on MODEL_LIGHT at low effort -- short, mechanical matching.
const KEYWORD_GAP_DIFF_PROMPT =
  'You are a UK careers adviser. The user sends a target role, a list of the ' +
  'skills/requirements most in demand for that role (drawn from real job ' +
  'adverts), and the true facts from their CV. Work out how the candidate ' +
  'measures up.\n\n' +
  'STRICT RULES:\n' +
  '- "matched": in-demand keywords the candidate can GENUINELY evidence from ' +
  'the CV facts, each as the keyword plus their true evidence. Never claim a ' +
  'match without evidence.\n' +
  '- "missing": in-demand keywords with no evidence in the CV facts — honest ' +
  'gaps to know about, never to fake. For each, say briefly why employers ask ' +
  'for it, and one way to genuinely close it: either a question about what ' +
  'they may already have done ("Did you…?") or a small concrete action ' +
  'completable within a few weeks.\n' +
  '- UK English. Banned words: leveraged, synergy, passionate, dynamic, ' +
  'results-driven, spearheaded.\n\n' +
  'OUTPUT — the response schema enforces the exact fields; populate "matched" ' +
  'and "missing" as described above.';

const KEYWORD_GAP_DIFF_SCHEMA = {
  type: 'object',
  properties: {
    matched: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['keyword', 'evidence'],
        additionalProperties: false,
      },
    },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          why_it_matters: { type: 'string' },
          how_to_get_it: { type: 'string' },
        },
        required: ['keyword', 'why_it_matters', 'how_to_get_it'],
        additionalProperties: false,
      },
    },
  },
  required: ['matched', 'missing'],
  additionalProperties: false,
};

const DIAGNOSE_MAX_TOKENS = 8000;

// Scores a CV the way an applicant tracking system parses it. Judgement only —
// nothing here rewrites the CV; the builder does that.
const DIAGNOSE_PROMPT =
  'You simulate a UK applicant tracking system (ATS) and a recruiter doing a ' +
  '30-second skim of a school-leaver / early-career CV. The user sends the raw ' +
  'text of their CV. Score how well it survives automated parsing and that skim.\n\n' +
  'CHECK FOR: missing or malformed contact details; missing dates or ' +
  'inconsistent date formats; a vague skills line with no concrete tools; ' +
  'non-standard section headings an ATS will not recognise; bullets with no ' +
  'active verb or no outcome; signs of tables, columns or graphics that break ' +
  'text-order parsing; a profile summary with no role-relevant keywords.\n\n' +
  'RULES:\n' +
  '- 3-8 flags, most severe first. Severity "high" only when it plausibly ' +
  'blocks parsing or causes instant rejection; otherwise "medium" or "low".\n' +
  '- Every fix is one concrete action the candidate can take today, UK English.\n' +
  '- Judge only what is in the text — never assume facts that are not there.\n' +
  '- Banned words: leveraged, synergy, passionate, dynamic, results-driven, ' +
  'spearheaded.\n\n' +
  'OUTPUT — the response schema enforces the exact fields; populate "score" ' +
  '(integer 0-100), "summary" (one-sentence overall verdict), and "flags" ' +
  '(each with "section", "severity" as exactly "high", "medium" or "low", ' +
  '"problem", and "fix").';

// JSON Schema for diagnoseCV's structured output. "severity" uses enum --
// enum/const/anyOf/allOf are all supported by the API's structured-outputs
// subset; only length/range constraints (minLength, maximum, etc.) are not.
// additionalProperties:false + required on every object; no length/range
// constraints (the API does not support those).
const DIAGNOSE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    summary: { type: 'string' },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['section', 'severity', 'problem', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['score', 'summary', 'flags'],
  additionalProperties: false,
};

const EXTRACT_MAX_TOKENS = 16000;

// Structures an uploaded CV's raw text into the builder's form fields.
// Extraction only — anything not present in the text stays empty.
const EXTRACT_PROMPT =
  'You extract facts from a school-leaver CV into JSON for a form. Use ONLY ' +
  'facts present in the text; use "" (or [] for lists) when something is ' +
  'absent — NEVER guess or invent.\n\n' +
  'Populate exactly these fields:\n' +
  '{"name":"","city":"","email":"","phone":"","links":"","school":"",' +
  '"schooldates":"","gcse":"",' +
  '"qualifications":[{"level":"","subject":"","grade":"","predicted":false}],' +
  '"projects":[{"title":"","desc":"","tools":"","outcome":""}],' +
  '"quant":"","skills":"","jobs":[{"role":"","org":"","dates":"","desc":""}],' +
  '"responsibility":"","sport":"","fitness":"","awards":"","interests":""}\n\n' +
  'Notes: "quant" = maths/competition/achievement evidence; "skills" = ' +
  'comma-separated tools and skills; "sport" = sports or physical activities; ' +
  '"responsibility" = prefect/captain/mentor-style roles; put anything that ' +
  'fits nowhere else into "interests". "qualifications" — one entry per ' +
  'qualification found (GCSE, A-level, AS-level, BTEC, T-Level, National 5, ' +
  'Higher, Advanced Higher, or Other); set "predicted" true only when the CV ' +
  'text itself says a grade is predicted/target/expected, never guess.\n\n' +
  'A FILENAME line may precede the CV text. Names often live in a Word ' +
  'header the text extractor cannot see — if the candidate\'s name is absent ' +
  'from the CV text but clearly present in the filename (e.g. "Jane Smith ' +
  'CV.docx"), use it for "name".';

// JSON Schema for extractCV's structured output, matching EXTRACT_PROMPT's
// documented shape exactly. additionalProperties:false + required on every
// object; no length/range constraints (the API does not support them).
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    city: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    links: { type: 'string' },
    school: { type: 'string' },
    schooldates: { type: 'string' },
    gcse: { type: 'string' },
    qualifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['GCSE', 'A-level', 'AS-level', 'BTEC', 'T-Level', 'National 5', 'Higher', 'Advanced Higher', 'Other'],
          },
          subject: { type: 'string' },
          grade: { type: 'string' },
          predicted: { type: 'boolean' },
        },
        required: ['level', 'subject', 'grade', 'predicted'],
        additionalProperties: false,
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          desc: { type: 'string' },
          tools: { type: 'string' },
          outcome: { type: 'string' },
        },
        required: ['title', 'desc', 'tools', 'outcome'],
        additionalProperties: false,
      },
    },
    quant: { type: 'string' },
    skills: { type: 'string' },
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          org: { type: 'string' },
          dates: { type: 'string' },
          desc: { type: 'string' },
        },
        required: ['role', 'org', 'dates', 'desc'],
        additionalProperties: false,
      },
    },
    responsibility: { type: 'string' },
    sport: { type: 'string' },
    fitness: { type: 'string' },
    awards: { type: 'string' },
    interests: { type: 'string' },
  },
  required: [
    'name', 'city', 'email', 'phone', 'links', 'school', 'schooldates', 'gcse',
    'qualifications', 'projects', 'quant', 'skills', 'jobs', 'responsibility', 'sport',
    'fitness', 'awards', 'interests',
  ],
  additionalProperties: false,
};

function createAnthropicClient(apiKey) {
  return new Anthropic({ apiKey });
}

// GDPR minimisation: facts pass through to the API and the result is returned to
// the caller — nothing here logs or persists CV content.
async function generateCV(client, facts) {
  const response = await client.messages.create({
    model: MODEL_GENERATE,
    max_tokens: MAX_TOKENS,
    // Content-block array + cache_control: this is the one route with a
    // large (~700-token), stable, per-request-identical system prompt --
    // it clears Opus 5's 512-token cache minimum. The other three routes'
    // prompts are smaller and/or vary less predictably in request volume,
    // so they stay uncached unless a later measurement says otherwise.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: facts }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function suggestIdeas(client, context) {
  const response = await client.messages.create({
    model: MODEL_LIGHT,
    max_tokens: SUGGEST_MAX_TOKENS,
    system: SUGGEST_PROMPT,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: context }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function polishEntry(client, { category, text, target }) {
  const content = `Field: ${category}\nTarget role: ${target || 'general early-career'}\nStudent note: ${text}`;
  const response = await client.messages.create({
    model: MODEL_LIGHT,
    max_tokens: POLISH_MAX_TOKENS,
    system: POLISH_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: polishSchema(category) } },
    messages: [{ role: 'user', content }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function tailorToJob(client, { job, facts }) {
  const content = 'JOB ADVERT:\n' + job + '\n\nCV FACTS:\n' + facts;
  const response = await client.messages.create({
    model: MODEL_LIGHT,
    max_tokens: TAILOR_MAX_TOKENS,
    system: TAILOR_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: TAILOR_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

// Stateless: the client holds the transcript ([{role, content}, …] of prior
// interviewer JSON turns and student answers) and sends it back each call.
async function interviewTurn(client, { role, advert, facts, transcript }) {
  const context =
    'TARGET ROLE: ' + role +
    (advert ? '\n\nJOB ADVERT:\n' + advert : '') +
    '\n\nCV FACTS:\n' + facts +
    '\n\nBegin (or continue) the interview.';
  const messages = [{ role: 'user', content: context }, ...transcript];
  // Cache the transcript prefix: mark the last already-sent turn as a
  // content-block array with cache_control, so the next call's growing
  // history reads this prefix at the cache-read discount. Nothing to cache
  // on the opening turn (empty transcript) -- there's no prior prefix yet.
  if (transcript.length > 0) {
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    messages[lastIndex] = {
      role: last.role,
      content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }],
    };
  }
  const response = await client.messages.create({
    model: INTERVIEW_MODEL,
    max_tokens: INTERVIEW_MAX_TOKENS,
    system: INTERVIEW_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: INTERVIEW_TURN_SCHEMA } },
    messages,
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

// Step 1 of the keyword-gap cost restructure (see server.js's per-role
// cache): extracts in-demand skills/requirements from a role's advert
// corpus. Called only on a cache miss.
async function keywordGapExtract(client, { role, corpus }) {
  const content = 'TARGET ROLE: ' + role + '\n\nJOB ADVERT CORPUS:\n' + corpus;
  const response = await client.messages.create({
    model: MODEL_EXTRACT,
    max_tokens: KEYWORD_GAP_EXTRACT_MAX_TOKENS,
    system: KEYWORD_GAP_EXTRACT_PROMPT,
    output_config: { format: { type: 'json_schema', schema: KEYWORD_GAP_EXTRACT_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

// Step 2 of the keyword-gap cost restructure: diffs one user's CV facts
// against the (possibly cached) in-demand list from keywordGapExtract.
// Called on every request, cache hit or miss.
async function keywordGapDiff(client, { role, inDemand, facts }) {
  const content =
    'TARGET ROLE: ' + role +
    '\n\nIN-DEMAND SKILLS/REQUIREMENTS (from real adverts):\n' + JSON.stringify(inDemand) +
    '\n\nCV FACTS:\n' + facts;
  const response = await client.messages.create({
    model: MODEL_LIGHT,
    max_tokens: KEYWORD_GAP_DIFF_MAX_TOKENS,
    system: KEYWORD_GAP_DIFF_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: KEYWORD_GAP_DIFF_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function diagnoseCV(client, text) {
  const response = await client.messages.create({
    model: MODEL_LIGHT,
    max_tokens: DIAGNOSE_MAX_TOKENS,
    system: DIAGNOSE_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DIAGNOSE_SCHEMA } },
    messages: [{ role: 'user', content: 'CV TEXT:\n' + text }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function extractCV(client, text, filename = '') {
  const content = (filename ? 'FILENAME: ' + filename + '\n' : '') + 'CV TEXT:\n' + text;
  const response = await client.messages.create({
    model: MODEL_EXTRACT,
    max_tokens: EXTRACT_MAX_TOKENS,
    system: EXTRACT_PROMPT,
    output_config: { format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  checkStopReason(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

module.exports = { createAnthropicClient, generateCV, suggestIdeas, polishEntry, extractCV, tailorToJob, diagnoseCV, keywordGapExtract, keywordGapDiff, interviewTurn, MODEL, MODEL_GENERATE, MODEL_LIGHT, MODEL_EXTRACT, INTERVIEW_MODEL, MAX_TOKENS, SYSTEM_PROMPT, SUGGEST_PROMPT, POLISH_PROMPT, EXTRACT_PROMPT, TAILOR_PROMPT, DIAGNOSE_PROMPT, KEYWORD_GAP_EXTRACT_PROMPT, KEYWORD_GAP_DIFF_PROMPT, INTERVIEW_PROMPT, ModelRefusalError, ModelTruncatedError };
