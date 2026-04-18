// Structural anchor matcher for the hidden Firedancer benchmark.
//
// WHY external: this module reads benchmark claim text and matches it against
// SmartAnon run artifacts. It must NEVER be imported from any file inside the
// SmartAnon repo, because doing so would leak benchmark anchors into agent context.
//
// Matching contract (per benchmark plan section 0.3):
//   * Each claim carries semantic_anchors with up to 7 anchor classes.
//   * A class "hits" a snapshot when at least one of its tokens appears in
//     the snapshot text (case-insensitive substring match).
//   * Stage status:
//       - hit:     >=2 distinct anchor classes hit at least one token
//       - partial: exactly 1 anchor class hit
//       - miss:    0 anchor classes hit
//   * Partial stages are eligible for llm-judge escalation (handled by score.mjs).
//
// Snapshots are pre-loaded by score.mjs into stage buckets so each claim only
// scans the relevant artifact group per stage. This keeps the full evaluator
// well under the 60s budget for typical run trees.

/**
 * @typedef {'hit' | 'partial' | 'miss'} StageStatus
 *
 * @typedef {Object} SnapshotEntry
 * @property {string} relPath           Relative path under deliverables/ or audit-logs/
 * @property {string} text              Lower-cased file content (may be JSON serialized)
 *
 * @typedef {Object} StageSnapshots
 * @property {SnapshotEntry[]} routed
 * @property {SnapshotEntry[]} hypothesized
 * @property {SnapshotEntry[]} investigated
 * @property {SnapshotEntry[]} promoted
 * @property {SnapshotEntry[]} finalized
 *
 * @typedef {Object} BenchmarkClaim
 * @property {string} claim_id
 * @property {string} subsystem
 * @property {string} expected_lane
 * @property {string} expected_status
 * @property {string} expected_outcome
 * @property {Object} semantic_anchors
 *
 * @typedef {Object} StageMatch
 * @property {StageStatus} status
 * @property {number} hit_classes
 * @property {Array<{ anchor_class: string, token: string, snapshot_path: string }>} hits
 *
 * @typedef {Object} ClaimScore
 * @property {string} claim_id
 * @property {StageMatch} routed
 * @property {StageMatch} hypothesized
 * @property {StageMatch} investigated
 * @property {StageMatch} promoted
 * @property {StageMatch} finalized
 * @property {string[]} match_evidence
 */

const ANCHOR_CLASSES = [
  'file_basename',
  'function_name',
  'struct_name',
  'macro_name',
  'state_machine_field',
  'pattern_keywords',
  'obligation_family',
];

const STAGES = ['routed', 'hypothesized', 'investigated', 'promoted', 'finalized'];

/**
 * Score one claim against pre-loaded stage snapshots.
 *
 * @param {BenchmarkClaim} claim
 * @param {StageSnapshots} snapshots
 * @param {{ maxHitsPerStage?: number }} [opts]
 * @returns {ClaimScore}
 */
export function matchClaim(claim, snapshots, opts = {}) {
  const maxHitsPerStage = opts.maxHitsPerStage ?? 8;
  const score = { claim_id: claim.claim_id, match_evidence: [] };

  for (const stage of STAGES) {
    const stageMatch = matchStage(claim, snapshots[stage] ?? [], maxHitsPerStage);
    score[stage] = stageMatch;
    for (const hit of stageMatch.hits) {
      score.match_evidence.push(`${stage}:${hit.anchor_class}=${hit.token} @ ${hit.snapshot_path}`);
    }
  }

  return score;
}

/**
 * @param {BenchmarkClaim} claim
 * @param {SnapshotEntry[]} snapshots
 * @param {number} maxHits
 * @returns {StageMatch}
 */
function matchStage(claim, snapshots, maxHits) {
  /** @type {Array<{ anchor_class: string, token: string, snapshot_path: string }>} */
  const hits = [];
  const classesHit = new Set();

  for (const klass of ANCHOR_CLASSES) {
    const tokens = normaliseTokens(claim.semantic_anchors?.[klass]);
    if (tokens.length === 0) continue;

    let classHasHit = false;
    for (const token of tokens) {
      const lcToken = token.toLowerCase();
      if (lcToken.length < 3) continue; // avoid trivial substrings like "cu"
      for (const snap of snapshots) {
        if (snap.text.includes(lcToken)) {
          if (hits.length < maxHits) {
            hits.push({ anchor_class: klass, token, snapshot_path: snap.relPath });
          }
          classHasHit = true;
          break; // one hit per (token, class) pair is enough
        }
      }
      if (classHasHit && hits.length >= maxHits) break;
    }
    if (classHasHit) classesHit.add(klass);
  }

  /** @type {StageStatus} */
  let status;
  if (classesHit.size >= 2) status = 'hit';
  else if (classesHit.size === 1) status = 'partial';
  else status = 'miss';

  return { status, hit_classes: classesHit.size, hits };
}

/**
 * Coerce an anchor class value (string | string[] | undefined) into a token list.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normaliseTokens(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.length > 0);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/**
 * Aggregate a list of claim scores into per-stage and per-lane counts.
 * Used by the score report and the miss-taxonomy classifier.
 *
 * @param {ClaimScore[]} scores
 * @param {BenchmarkClaim[]} claims
 * @returns {{
 *   per_stage: Record<string, { hit: number, partial: number, miss: number }>,
 *   per_lane: Record<string, { total: number, finalized_hit: number, promoted_hit: number, investigated_hit: number, hypothesized_hit: number, routed_hit: number }>,
 *   total_claims: number,
 * }}
 */
export function aggregateScores(scores, claims) {
  const per_stage = {};
  for (const stage of STAGES) {
    per_stage[stage] = { hit: 0, partial: 0, miss: 0 };
  }

  const per_lane = {};
  const claimsById = new Map(claims.map((c) => [c.claim_id, c]));

  for (const score of scores) {
    for (const stage of STAGES) {
      const status = score[stage]?.status ?? 'miss';
      per_stage[stage][status] += 1;
    }
    const claim = claimsById.get(score.claim_id);
    if (!claim) continue;
    const lane = claim.expected_lane;
    if (!per_lane[lane]) {
      per_lane[lane] = {
        total: 0,
        finalized_hit: 0,
        promoted_hit: 0,
        investigated_hit: 0,
        hypothesized_hit: 0,
        routed_hit: 0,
      };
    }
    per_lane[lane].total += 1;
    if (score.finalized?.status === 'hit') per_lane[lane].finalized_hit += 1;
    if (score.promoted?.status === 'hit') per_lane[lane].promoted_hit += 1;
    if (score.investigated?.status === 'hit') per_lane[lane].investigated_hit += 1;
    if (score.hypothesized?.status === 'hit') per_lane[lane].hypothesized_hit += 1;
    if (score.routed?.status === 'hit') per_lane[lane].routed_hit += 1;
  }

  return { per_stage, per_lane, total_claims: scores.length };
}

export { ANCHOR_CLASSES, STAGES };
