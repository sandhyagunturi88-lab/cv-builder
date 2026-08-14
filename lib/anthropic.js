'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 2000;

const SYSTEM_PROMPT =
  'You are a UK careers adviser. Rewrite the CV facts supplied into a one-page ' +
  'UK-format CV. Use ONLY supplied facts; items marked NONE are omitted, never ' +
  'invented. No photo, DOB, or full address. Every bullet starts with an active ' +
  'verb. Banned words: leveraged, synergy, passionate, dynamic, results-driven, ' +
  'spearheaded.\n\n' +
  'FORMAT — follow exactly, the output is machine-parsed:\n' +
  '- Return the CV as Markdown.\n' +
  '- First line: the candidate\'s name as a level-1 heading ("# Name").\n' +
  '- Second line: contact details on one line, separated by " | ".\n' +
  '- Every CV section as a level-2 heading ("## Section Name") followed by short ' +
  'paragraphs or "- " bullets.\n' +
  '- No tables, blockquotes, code fences, or horizontal rules inside the CV.\n\n' +
  'After the CV, output a line containing only "---", then a "## Feedback" section with:\n' +
  '- Short "- " bullets naming the weakest sections and why.\n' +
  '- Then the exact heading "### Three actions for the next six months to create public ' +
  'evidence" followed by exactly 3 "- " bullets tailored to the stated target role. Each ' +
  'bullet: a bold imperative sentence naming the action ("**Do X.**"), then an achievability ' +
  'tag in square brackets — [Quick win], [Likely], or [Stretch] — then 1-3 sentences ' +
  'explaining why this strengthens THIS CV for THIS target role, referencing the supplied facts.';

const SUGGEST_MAX_TOKENS = 700;

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

const POLISH_MAX_TOKENS = 300;

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
  '- If a strengthening detail is missing, mark where it goes with a ' +
  '[square-bracket placeholder] such as [year] or [number of customers].\n' +
  '- Banned words: leveraged, synergy, passionate, dynamic, results-driven, spearheaded.\n\n' +
  'OUTPUT — return ONLY raw JSON: no code fences, no prose, no wrapper keys.\n' +
  '- field "project": exactly {"title": "short project name", "desc": "one or two ' +
  'short sentences describing what was done and with what"}\n' +
  '- field "job": exactly {"role": "job title", "org": "organisation", "dates": ' +
  '"dates", "desc": "one or two short sentences of what they did"} — use ' +
  '[placeholders] for role, org or dates if not stated\n' +
  '- any other field ("achievement", "skill", "responsibility", "sport", "award", ' +
  '"interest"): exactly {"text": "the single line"}';

const EXTRACT_MAX_TOKENS = 1500;

// Structures an uploaded CV's raw text into the builder's form fields.
// Extraction only — anything not present in the text stays empty.
const EXTRACT_PROMPT =
  'You extract facts from a school-leaver CV into JSON for a form. Use ONLY ' +
  'facts present in the text; use "" (or [] for lists) when something is ' +
  'absent — NEVER guess or invent.\n\n' +
  'Return ONLY raw JSON, no code fences, with exactly these keys:\n' +
  '{"name":"","city":"","email":"","phone":"","links":"","school":"",' +
  '"schooldates":"","gcse":"",' +
  '"alevels":[{"subj":"","grade":""}],' +
  '"projects":[{"title":"","desc":"","tools":"","outcome":""}],' +
  '"quant":"","skills":"","jobs":[{"role":"","org":"","dates":"","desc":""}],' +
  '"responsibility":"","sport":"","fitness":"","awards":"","interests":""}\n\n' +
  'Notes: "quant" = maths/competition/achievement evidence; "skills" = ' +
  'comma-separated tools and skills; "sport" = sports or physical activities; ' +
  '"responsibility" = prefect/captain/mentor-style roles; put anything that ' +
  'fits nowhere else into "interests".';

function createAnthropicClient(apiKey) {
  return new Anthropic({ apiKey });
}

// GDPR minimisation: facts pass through to the API and the result is returned to
// the caller — nothing here logs or persists CV content.
async function generateCV(client, facts) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: facts }],
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function suggestIdeas(client, context) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: SUGGEST_MAX_TOKENS,
    system: SUGGEST_PROMPT,
    messages: [{ role: 'user', content: context }],
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function polishEntry(client, { category, text, target }) {
  const content = `Field: ${category}\nTarget role: ${target || 'general early-career'}\nStudent note: ${text}`;
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: POLISH_MAX_TOKENS,
    system: POLISH_PROMPT,
    messages: [{ role: 'user', content }],
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function extractCV(client, text) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: EXTRACT_MAX_TOKENS,
    system: EXTRACT_PROMPT,
    messages: [{ role: 'user', content: 'CV TEXT:\n' + text }],
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

module.exports = { createAnthropicClient, generateCV, suggestIdeas, polishEntry, extractCV, MODEL, MAX_TOKENS, SYSTEM_PROMPT, SUGGEST_PROMPT, POLISH_PROMPT, EXTRACT_PROMPT };
