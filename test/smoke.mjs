// Smoke test for the hidden benchmark evaluator.
//
// Verifies the two acceptance bars from plan section 0.7:
//   1. Zero false-positive matches on a synthetic run with all queues empty.
//   2. Evaluator runs in under 60s on a typical output tree.
//
// Run with:  node C:/Users/brazd/.claude/eval/native-validator/test/smoke.mjs

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

const fixtureDir = join(__dirname, 'fixtures', 'empty_deliverables');
const outDir = mkdtempSync(join(tmpdir(), 'sa-eval-smoke-'));

console.log(`smoke fixture: ${fixtureDir}`);
console.log(`smoke output : ${outDir}`);

const t0 = Date.now();
const r = spawnSync(process.execPath, [
  join(ROOT, 'score.mjs'),
  '--benchmark', 'firedancer-v1-immunefi',
  '--target-deliverables', fixtureDir,
  '--out', outDir,
  '--dry-run',
], { encoding: 'utf8' });
const runtimeMs = Date.now() - t0;

if (r.status !== 0) {
  console.error(`score.mjs exited ${r.status}`);
  console.error('stdout:', r.stdout);
  console.error('stderr:', r.stderr);
  process.exit(1);
}

const stageScores = JSON.parse(readFileSync(join(outDir, 'stage_scores.json'), 'utf8'));
const summary = stageScores.summary;
let totalHits = 0;
let totalPartials = 0;
for (const stage of Object.keys(summary.per_stage)) {
  totalHits += summary.per_stage[stage].hit;
  totalPartials += summary.per_stage[stage].partial;
}

const failures = [];
if (totalHits !== 0) failures.push(`expected 0 stage hits on empty fixture, got ${totalHits}`);
if (runtimeMs >= 60_000) failures.push(`evaluator runtime ${runtimeMs}ms exceeds 60s budget`);
if (stageScores.scores.length < 75) failures.push(`expected >=75 scores, got ${stageScores.scores.length}`);

if (failures.length > 0) {
  console.error('SMOKE FAIL:');
  for (const f of failures) console.error(`  - ${f}`);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`SMOKE PASS: ${stageScores.scores.length} claims scored, ${totalHits} hits, ${totalPartials} partials, runtime ${runtimeMs} ms`);
rmSync(outDir, { recursive: true, force: true });
