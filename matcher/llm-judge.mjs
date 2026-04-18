// Near-miss escalation judge for the hidden Firedancer benchmark.
//
// Triggered by score.mjs when anchor-matcher returns `partial` (exactly one
// anchor class hit) for a stage. The judge sees ONLY the claim's mechanism
// description and a short excerpt from the candidate snapshot. It must never
// surface a "near miss" decision back into the SmartAnon repo or its prompts.
//
// Decision values: 'match' | 'near_miss' | 'no_match' | 'skip' (skip => no key, dry run, or transient error).
//
// Key handling: reads ANTHROPIC_API_KEY from process.env. If absent, the
// judge skips silently — score.mjs will downgrade partial to its anchor-only
// status. This keeps the evaluator usable on machines without API access.

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TIMEOUT_MS = 15_000;
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * @typedef {Object} JudgeRequest
 * @property {{ claim_id: string, subsystem: string, expected_lane: string, semantic_anchors: object }} claim
 * @property {{ stage: string, snapshot_path: string, excerpt: string, anchor_class: string, token: string }} candidate
 *
 * @typedef {Object} JudgeResponse
 * @property {'match' | 'near_miss' | 'no_match' | 'skip'} decision
 * @property {string} reason
 * @property {string} [model]
 * @property {number} [latency_ms]
 */

/**
 * @param {JudgeRequest} req
 * @param {{ dryRun?: boolean, model?: string, maxTokens?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<JudgeResponse>}
 */
export async function judgeNearMiss(req, opts = {}) {
  const dryRun = opts.dryRun === true;
  if (dryRun) return { decision: 'skip', reason: 'dry-run mode' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { decision: 'skip', reason: 'ANTHROPIC_API_KEY not set' };

  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const prompt = buildPrompt(req);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const start = Date.now();
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });

    clearTimeout(timer);
    const latency_ms = Date.now() - start;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { decision: 'skip', reason: `HTTP ${resp.status}: ${text.slice(0, 200)}`, model, latency_ms };
    }

    const data = await resp.json();
    const text = extractText(data);
    const parsed = parseDecision(text);
    return { ...parsed, model, latency_ms };
  } catch (err) {
    clearTimeout(timer);
    return { decision: 'skip', reason: `error: ${err?.message ?? String(err)}` };
  }
}

/**
 * @param {JudgeRequest} req
 * @returns {string}
 */
function buildPrompt(req) {
  const anchors = JSON.stringify(req.claim.semantic_anchors, null, 2);
  return [
    'You are an evaluator judging whether a SmartAnon analysis artifact covers a known native-validator vulnerability mechanism.',
    'You will see only the bug MECHANISM (anchors) and a short excerpt from one analysis artifact. Decide whether the artifact substantively covers that mechanism.',
    '',
    'Bug mechanism (anchors only, no source-code references):',
    `- subsystem: ${req.claim.subsystem}`,
    `- expected_lane: ${req.claim.expected_lane}`,
    `- semantic_anchors:\n${anchors}`,
    '',
    `Candidate excerpt (stage="${req.candidate.stage}", anchor_class="${req.candidate.anchor_class}", matched_token="${req.candidate.token}", path="${req.candidate.snapshot_path}"):`,
    '"""',
    req.candidate.excerpt.slice(0, 1800),
    '"""',
    '',
    'Reply on a SINGLE LINE in this exact format:',
    'DECISION=<match|near_miss|no_match> REASON=<one short sentence>',
    '',
    'Rules:',
    '- match     => the excerpt clearly addresses this mechanism',
    '- near_miss => mentions an adjacent mechanism but not this one',
    '- no_match  => unrelated or coincidental token overlap',
  ].join('\n');
}

/**
 * @param {unknown} data
 * @returns {string}
 */
function extractText(data) {
  if (!data || typeof data !== 'object') return '';
  const content = /** @type {{ content?: Array<{ type: string, text?: string }> }} */ (data).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .trim();
}

/**
 * @param {string} text
 * @returns {{ decision: 'match' | 'near_miss' | 'no_match', reason: string }}
 */
function parseDecision(text) {
  const decisionMatch = text.match(/DECISION\s*=\s*(match|near_miss|no_match)/i);
  const reasonMatch = text.match(/REASON\s*=\s*(.+)$/im);
  if (!decisionMatch) {
    return { decision: 'no_match', reason: `unparseable judge reply: ${text.slice(0, 120)}` };
  }
  const decision = /** @type {'match' | 'near_miss' | 'no_match'} */ (decisionMatch[1].toLowerCase());
  const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 200) : 'no reason provided';
  return { decision, reason };
}

export { DEFAULT_MODEL };
