#!/usr/bin/env node
// Hidden benchmark evaluator CLI for SmartAnon native validator runs.
//
// WHY external: this script reads benchmark labels and scores SmartAnon run
// outputs against them. It deliberately lives outside the repo so no agent,
// prompt, or deliverable can ever reference benchmark anchors.
//
// Inputs (read-only):
//   --benchmark <id>                 benchmark JSON under ./benchmarks/<id>.json
//   --target-deliverables <path>     repos/<target>/deliverables (read-only)
//   --audit-logs <path>              audit-logs/<host>_<sessionId> (read-only)
//   --out <path>                     output dir for stage_scores/miss_taxonomy/score_report
//   --dry-run                        skip the LLM judge entirely
//   --benchmark-dir <path>           override benchmarks dir (defaults to sibling ./benchmarks)
//   --max-judge-calls <n>            cap LLM judge calls (default 30)
//
// Outputs (written under --out):
//   stage_scores.json
//   miss_taxonomy.json
//   score_report.md
//
// Acceptance contract (plan section 0.7):
//   * Runs in <60s on a typical full-run output tree.
//   * Zero false positives on a synthetic run with all queues empty.
//   * No write outside --out. No write inside the SmartAnon repo.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchClaim, aggregateScores, ANCHOR_CLASSES, STAGES } from './matcher/anchor-matcher.mjs';
import { judgeNearMiss } from './matcher/llm-judge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Stage routing ---------------------------------------------------------
//
// Each filename pattern maps to one or more pipeline stages. A file may
// contribute to multiple stages (e.g., decision_cards inform both
// "investigated" and "routed"). Stage scoring uses set semantics, so the
// same hit only counts once per stage.
const STAGE_FILE_PATTERNS = {
  routed: [
    'system_model.json',
    'weirdness_map.json',
    'native_surface_map.json',
    'native_check_results.json',
    'invariant_',           // invariant-discovery shards + reducer
    'context_pack',
    'recon_',
    'pre_recon',
    'attack_surface',
    'diff_risk_input',
    'intent_analysis_scope',
    'input_forward_scope',
    'impact_backward_scope',
    'intent_analysis',
    'input_forward_analysis',
    'impact_backward_analysis',
  ],
  hypothesized: [
    'hypothesis_ranking.json',
    'hypothesis_queue.json',
    'diff_risk_queue.json',
    'intent_hypothesis_queue.json',
    'input_forward_hypothesis_queue.json',
    'impact_backward_hypothesis_queue.json',
    'chaining_hypothesis_queue.json',
    'hypothesis_evidence.json',
  ],
  investigated: [
    '_decision_cards.json',
    '_critique.json',
    '_reasoning_context.json',
  ],
  promoted: [
    '_exploitation_queue.json',
  ],
  finalized: [
    'final_findings.json',
  ],
};

// --- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
  const args = {
    benchmark: null,
    targetDeliverables: null,
    auditLogs: null,
    out: null,
    dryRun: false,
    benchmarkDir: join(__dirname, 'benchmarks'),
    maxJudgeCalls: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--benchmark': args.benchmark = next(); break;
      case '--target-deliverables': args.targetDeliverables = next(); break;
      case '--audit-logs': args.auditLogs = next(); break;
      case '--out': args.out = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--benchmark-dir': args.benchmarkDir = next(); break;
      case '--max-judge-calls': args.maxJudgeCalls = Number(next()) || 0; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        console.error(`unknown arg: ${a}`);
        printUsage();
        process.exit(2);
    }
  }
  if (!args.benchmark || !args.targetDeliverables || !args.out) {
    console.error('missing required args');
    printUsage();
    process.exit(2);
  }
  return args;
}

function printUsage() {
  console.error('usage: node score.mjs --benchmark <id> --target-deliverables <path> [--audit-logs <path>] --out <path> [--dry-run] [--max-judge-calls N]');
}

// --- Snapshot loading ------------------------------------------------------

function listFilesRecursive(root, maxBytes = 8 * 1024 * 1024) {
  if (!existsSync(root)) return [];
  /** @type {string[]} */
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = statSync(full).size; } catch { continue; }
        if (size > maxBytes) continue; // skip giant binaries / corpora
        out.push(full);
      }
    }
  }
  return out;
}

function loadFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function classifyForStages(relPath) {
  const lc = relPath.toLowerCase();
  /** @type {Set<string>} */
  const stages = new Set();
  for (const stage of STAGES) {
    for (const pat of STAGE_FILE_PATTERNS[stage]) {
      if (lc.includes(pat.toLowerCase())) {
        stages.add(stage);
        break;
      }
    }
  }
  // Fallback: any deliverable not explicitly classified counts as "routed".
  // Audit-log files that don't match any stage pattern are dropped (they're
  // mostly per-agent transcripts that don't reflect stage outcomes).
  return stages;
}

function buildSnapshots({ targetDeliverables, auditLogs }) {
  /** @type {Record<string, Array<{ relPath: string, text: string }>>} */
  const stageSnapshots = {};
  for (const stage of STAGES) stageSnapshots[stage] = [];

  // 1. Deliverables -- primary source.
  const delivRoot = resolve(targetDeliverables);
  const delivFiles = listFilesRecursive(delivRoot);
  for (const full of delivFiles) {
    const rel = relative(delivRoot, full);
    const lc = rel.toLowerCase();
    if (!(lc.endsWith('.json') || lc.endsWith('.md') || lc.endsWith('.txt'))) continue;
    const stages = classifyForStages(rel);
    if (stages.size === 0) stages.add('routed');
    const text = loadFile(full).toLowerCase();
    if (text.length === 0) continue;
    const entry = { relPath: `deliverables/${rel.replaceAll('\\', '/')}`, text };
    for (const stage of stages) stageSnapshots[stage].push(entry);
  }

  // 2. Audit logs -- supplementary, only patterns that map cleanly.
  if (auditLogs) {
    const auditRoot = resolve(auditLogs);
    const auditFiles = listFilesRecursive(auditRoot);
    for (const full of auditFiles) {
      const rel = relative(auditRoot, full);
      const lc = rel.toLowerCase();
      if (!(lc.endsWith('.json') || lc.endsWith('.md') || lc.endsWith('.txt'))) continue;
      const stages = classifyForStages(rel);
      if (stages.size === 0) continue; // audit-log only counts when it matches a stage pattern
      const text = loadFile(full).toLowerCase();
      if (text.length === 0) continue;
      const entry = { relPath: `audit-logs/${rel.replaceAll('\\', '/')}`, text };
      for (const stage of stages) stageSnapshots[stage].push(entry);
    }
  }

  return stageSnapshots;
}

// --- Outcome alignment & miss taxonomy ------------------------------------

const EXPECTED_OUTCOME_REQUIRED_STAGE = {
  final_finding: 'finalized',
  vulnerable_card: 'promoted',
  needs_followup_card: 'investigated',
  safe_card: 'investigated',
  coverage_note: 'routed',
};

function classifyMiss(claim, score) {
  const required = EXPECTED_OUTCOME_REQUIRED_STAGE[claim.expected_outcome];
  if (!required) {
    return { miss_class: 'never_routed', closest_stage: 'routed' };
  }

  if (score[required].status === 'hit') {
    return null; // not a miss
  }

  // Walk back through stages to find the latest one that *did* hit.
  const chain = ['routed', 'hypothesized', 'investigated', 'promoted', 'finalized'];
  const reqIdx = chain.indexOf(required);
  let highestHit = -1;
  for (let i = 0; i <= reqIdx; i++) {
    if (score[chain[i]]?.status === 'hit') highestHit = i;
  }

  if (highestHit < 0) {
    return { miss_class: 'never_routed', closest_stage: 'routed' };
  }

  const hitStage = chain[highestHit];
  const nextStage = chain[highestHit + 1];

  // The semantics map cleanly when expected_outcome implies a specific gap.
  if (hitStage === 'routed' && nextStage === 'hypothesized') {
    return { miss_class: 'routed_no_hypothesis', closest_stage: hitStage };
  }
  if (hitStage === 'hypothesized' && nextStage === 'investigated') {
    return { miss_class: 'hypothesis_wrong_lane', closest_stage: hitStage };
  }
  if (hitStage === 'investigated' && nextStage === 'promoted') {
    return { miss_class: 'investigated_wrongly_dismissed', closest_stage: hitStage };
  }
  if (hitStage === 'promoted' && nextStage === 'finalized') {
    return { miss_class: 'aggregation_loss', closest_stage: hitStage };
  }
  // Fallthrough: a stage hit beyond the required (shouldn't happen unless
  // expected_outcome is misaligned). Treat as covered but note it.
  return { miss_class: 'never_routed', closest_stage: hitStage };
}

// Mechanism-only generic detector suggestion. Phrased as a class, never as
// a target-specific signature.
function suggestGenericDetector(claim) {
  const families = claim.semantic_anchors?.obligation_family ?? [];
  if (families.length > 0) {
    return `add obligation-family detector for: ${families.join(', ')}`;
  }
  return `add structural detector for ${claim.expected_lane} surface in subsystem ${claim.subsystem}`;
}

// --- Report generation -----------------------------------------------------

function formatScoreReport({ benchmarkId, summary, scores, claims, missTaxonomy, judgeStats, runtimeMs }) {
  const lines = [];
  lines.push(`# Native Validator Benchmark Score Report`);
  lines.push('');
  lines.push(`- benchmark: \`${benchmarkId}\``);
  lines.push(`- claims scored: ${scores.length}`);
  lines.push(`- runtime: ${runtimeMs} ms`);
  lines.push(`- llm-judge: ${judgeStats.calls} calls (skipped=${judgeStats.skipped}, dryRun=${judgeStats.dryRun})`);
  lines.push('');

  lines.push(`## Stage coverage`);
  lines.push('');
  lines.push(`| Stage | hit | partial | miss |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const stage of STAGES) {
    const s = summary.per_stage[stage];
    lines.push(`| ${stage} | ${s.hit} | ${s.partial} | ${s.miss} |`);
  }
  lines.push('');

  lines.push(`## Lane coverage (lanes touched by >=1 expected claim)`);
  lines.push('');
  lines.push(`| Lane | total | finalized | promoted | investigated | hypothesized | routed |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  const laneNames = Object.keys(summary.per_lane).sort();
  for (const lane of laneNames) {
    const l = summary.per_lane[lane];
    lines.push(`| ${lane} | ${l.total} | ${l.finalized_hit} | ${l.promoted_hit} | ${l.investigated_hit} | ${l.hypothesized_hit} | ${l.routed_hit} |`);
  }
  lines.push('');

  lines.push(`## Miss taxonomy`);
  lines.push('');
  if (missTaxonomy.length === 0) {
    lines.push(`No misses recorded.`);
  } else {
    const counts = {};
    for (const m of missTaxonomy) counts[m.miss_class] = (counts[m.miss_class] ?? 0) + 1;
    lines.push(`| Miss class | Count |`);
    lines.push(`|---|---:|`);
    for (const k of Object.keys(counts).sort()) {
      lines.push(`| ${k} | ${counts[k]} |`);
    }
    lines.push('');
    lines.push(`### Per-claim`);
    lines.push('');
    lines.push(`| claim_id | lane | miss_class | closest_stage | suggestion |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of missTaxonomy) {
      lines.push(`| ${m.claim_id} | ${m.expected_lane} | ${m.miss_class} | ${m.closest_stage} | ${m.suggested_detector} |`);
    }
  }
  lines.push('');

  // Anchor quality summary -- highlights placeholder claims that need gh-fetch enrichment.
  const anchorBuckets = { full: 0, 'subsystem-only': 0, placeholder: 0 };
  for (const c of claims) {
    const q = c._anchor_quality ?? 'full';
    anchorBuckets[q] = (anchorBuckets[q] ?? 0) + 1;
  }
  lines.push(`## Benchmark anchor quality`);
  lines.push('');
  for (const k of Object.keys(anchorBuckets)) {
    lines.push(`- ${k}: ${anchorBuckets[k]}`);
  }
  if (anchorBuckets.placeholder > 0) {
    lines.push('');
    lines.push(`> ${anchorBuckets.placeholder} placeholder claims need full anchors. Run \`gh issue view <n> -R firedancer-io/firedancer\` for each \`_todo_fetch\` entry in the benchmark JSON.`);
  }

  return lines.join('\n') + '\n';
}

// --- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const benchmarkPath = join(args.benchmarkDir, `${args.benchmark}.json`);
  if (!existsSync(benchmarkPath)) {
    console.error(`benchmark not found: ${benchmarkPath}`);
    process.exit(1);
  }

  const benchmark = JSON.parse(loadFile(benchmarkPath));
  const claims = benchmark.claims ?? [];
  if (!Array.isArray(claims) || claims.length === 0) {
    console.error('benchmark has no claims');
    process.exit(1);
  }

  const snapshots = buildSnapshots({
    targetDeliverables: args.targetDeliverables,
    auditLogs: args.auditLogs,
  });

  const scores = [];
  const judgeStats = { calls: 0, skipped: 0, dryRun: args.dryRun };
  for (const claim of claims) {
    const score = matchClaim(claim, snapshots);

    // Near-miss escalation: any stage with status 'partial' is eligible. We
    // bound LLM judge calls at args.maxJudgeCalls across the whole run.
    for (const stage of STAGES) {
      if (score[stage]?.status !== 'partial') continue;
      if (judgeStats.calls >= args.maxJudgeCalls) {
        judgeStats.skipped += 1;
        continue;
      }
      const hit = score[stage].hits[0];
      if (!hit) continue;
      const snapEntry = (snapshots[stage] ?? []).find((s) => s.relPath === hit.snapshot_path);
      if (!snapEntry) continue;
      const excerpt = excerptAround(snapEntry.text, hit.token, 600);
      // eslint-disable-next-line no-await-in-loop -- judge calls are intentionally serialized to bound spend.
      const verdict = await judgeNearMiss(
        {
          claim,
          candidate: { stage, snapshot_path: hit.snapshot_path, excerpt, anchor_class: hit.anchor_class, token: hit.token },
        },
        { dryRun: args.dryRun },
      );
      judgeStats.calls += 1;
      if (verdict.decision === 'match') {
        score[stage].status = 'hit';
        score.match_evidence.push(`${stage}:judge_promoted partial->hit reason="${verdict.reason}"`);
      } else if (verdict.decision === 'no_match') {
        score[stage].status = 'miss';
        score.match_evidence.push(`${stage}:judge_demoted partial->miss reason="${verdict.reason}"`);
      } else if (verdict.decision === 'near_miss') {
        score.match_evidence.push(`${stage}:judge_kept_partial reason="${verdict.reason}"`);
      } else {
        judgeStats.skipped += 1;
      }
    }

    scores.push(score);
  }

  const summary = aggregateScores(scores, claims);

  /** @type {Array<{ claim_id: string, expected_lane: string, miss_class: string, closest_stage: string, anchor_gap: string[], suggested_detector: string }>} */
  const missTaxonomy = [];
  for (const claim of claims) {
    const score = scores.find((s) => s.claim_id === claim.claim_id);
    if (!score) continue;
    const miss = classifyMiss(claim, score);
    if (!miss) continue;
    missTaxonomy.push({
      claim_id: claim.claim_id,
      expected_lane: claim.expected_lane,
      miss_class: miss.miss_class,
      closest_stage: miss.closest_stage,
      anchor_gap: ANCHOR_CLASSES.filter((k) => {
        const tokens = claim.semantic_anchors?.[k];
        if (!Array.isArray(tokens) || tokens.length === 0) return false;
        // anchor_gap = anchor classes that exist in the claim but never matched anywhere
        return !STAGES.some((stg) => (score[stg]?.hits ?? []).some((h) => h.anchor_class === k));
      }),
      suggested_detector: suggestGenericDetector(claim),
    });
  }

  // Write outputs
  mkdirSync(args.out, { recursive: true });
  writeFileSync(
    join(args.out, 'stage_scores.json'),
    JSON.stringify({ benchmark: args.benchmark, generated_at: new Date().toISOString(), summary, scores }, null, 2),
  );
  writeFileSync(
    join(args.out, 'miss_taxonomy.json'),
    JSON.stringify({ benchmark: args.benchmark, generated_at: new Date().toISOString(), entries: missTaxonomy }, null, 2),
  );
  const runtimeMs = Date.now() - t0;
  writeFileSync(
    join(args.out, 'score_report.md'),
    formatScoreReport({
      benchmarkId: args.benchmark,
      summary,
      scores,
      claims,
      missTaxonomy,
      judgeStats,
      runtimeMs,
    }),
  );

  console.log(`scored ${scores.length} claims in ${runtimeMs} ms; output -> ${args.out}`);
}

function excerptAround(text, token, radius) {
  const idx = text.indexOf(token.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + token.length + radius);
  return text.slice(start, end);
}

main().catch((err) => {
  console.error(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
