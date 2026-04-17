# Evaluation

This is the evaluation setup. It tells agents and reviewers how to set up,
run experiments, and measure results. Both experimenters and reviewers
follow the same instructions.

This file is the trust boundary. The evaluation code it references is
outside the editable surface. Agents cannot change how they are judged.

## Setup

One-time per machine and per fresh worktree:

```
npm ci
```

Installs Node deps (TypeScript, vitest, size-limit, ts-scripts). Requires
Node 18+; the harness itself runs on any Node supporting ES modules and
`process.hrtime.bigint()`.

Before every evaluation, rebuild the dist:

```
npm run build
```

The evaluator imports the built `dist/index.js`, not the TypeScript source.
If you skip the build, you will measure the previous candidate.

## Running an experiment

From the worktree root, gate + bench as one pipeline:

```
npm test && npm run build && node .polyresearch/bench.mjs > run.log 2>&1
```

- `npm test` runs prettier, tsc --build, tsc --noEmit, vitest with v8
  coverage (198 tests including top-sites snapshots for both parsers), and
  `npm run size` (size-limit against the 1.5 KB budget). A failure here is
  a hard reject — the candidate violates a non-speed invariant.
- `npm run build` emits `dist/index.js` from `src/index.ts` via
  `tsconfig.build.json`.
- `node .polyresearch/bench.mjs` runs the polyresearch harness (see below).

If any step in the pipeline fails, the observation is `crashed` or
`infra_failure` — it is never `improved`, no matter what the prior step
printed.

### Harness knobs (environment variables)

- `POLYRESEARCH_MIN_MEASURE_MS` — minimum wall time per batch per workload.
  Default `2000` (2 s). Raise to `5000` for low-noise reruns.
- `POLYRESEARCH_BATCH_COUNT` — number of batches to collect. Default `7`.
  The reported metric is the median of batch means. Raise to `11` for
  low-noise reruns.
- `POLYRESEARCH_WARMUP_PASSES` — corpus passes discarded before timing.
  Default `3`.

Do not change defaults in submitted runs unless the run is an explicit
low-noise rerun (note this in the `--summary`).

### Variance handling

After a run, compute `stdev / median` for the primary and the guard. If
either exceeds `0.03` (3%), rerun with `POLYRESEARCH_MIN_MEASURE_MS=5000
POLYRESEARCH_BATCH_COUNT=11` and report the mean of two runs. Note the
exact config in the `--summary`.

If a single experiment exceeds 2x the expected wall time (roughly 30 s on
defaults across the full `npm test && build && bench` pipeline), kill it
and record the observation as `crashed`.

## Output format

`node .polyresearch/bench.mjs` prints a human-readable header and then a
machine-readable JSON block between the sentinel lines
`=== POLYRESEARCH_RESULT_BEGIN ===` and `=== POLYRESEARCH_RESULT_END ===`.

Example output (trimmed, numbers are representative not canonical):

```
=== polyresearch cookie bench ===
node: v22.11.0 darwin/arm64
batches: 7, min_measure_ms: 2000, warmup_passes: 3

PRIMARY: parseCookie/top-cookie  (corpus=14 strings)
  ns/call  median=198.12  min=197.40  max=199.81  stdev=0.85
  ms/1M    198.12
  fingerprint 3f4826aec2a7d27db32ee20fb0cff825a813183dffcf71e87eb0f3230bb1653a

GUARD:   parseSetCookie/top-set-cookie  (corpus=38 strings)
  ns/call  median=398.02  min=397.12  max=399.44  stdev=0.81
  ms/1M    398.02
  fingerprint 7b8d8f0d4d6fb8c451d0749bf225890ea033e95a7f423e3ca136866928bb5d39

=== POLYRESEARCH_RESULT_BEGIN ===
{"meta":{...},"primary":{...},"guard":{...}}
=== POLYRESEARCH_RESULT_END ===
```

The JSON block is the authoritative result.

## Parsing the metric

A helper is shipped to extract fields without jq:

```
node .polyresearch/parse-metric.mjs run.log primary     # primary ns/call median
node .polyresearch/parse-metric.mjs run.log guard       # guard ns/call median
node .polyresearch/parse-metric.mjs run.log primary_fp  # primary fingerprint
node .polyresearch/parse-metric.mjs run.log guard_fp    # guard fingerprint
```

Each command prints a single value on stdout, no trailing newline.

When submitting to `polyresearch attempt`:

```
METRIC=$(node .polyresearch/parse-metric.mjs run.log primary)
BASELINE=$(node .polyresearch/parse-metric.mjs baseline.log primary)
GUARD_METRIC=$(node .polyresearch/parse-metric.mjs run.log guard)
GUARD_BASELINE=$(node .polyresearch/parse-metric.mjs baseline.log guard)
PRIMARY_FP=$(node .polyresearch/parse-metric.mjs run.log primary_fp)
GUARD_FP=$(node .polyresearch/parse-metric.mjs run.log guard_fp)

polyresearch attempt <issue> \
  --metric "$METRIC" --baseline "$BASELINE" \
  --observation <improved|no_improvement|crashed|infra_failure> \
  --summary "primary <delta_ms> ms/1M (<pct>%), guard <g_delta> ms/1M (<g_pct>%), fp <PRIMARY_FP> / <GUARD_FP>"
```

`<delta_ms> = baseline - metric` (ms per 1M calls; positive means faster).
`<pct> = (baseline - metric) / baseline * 100`.

## Acceptance rules

A candidate is `improved` iff ALL of:

1. `npm test` passes.
2. `npm run build` succeeds.
3. Bench completes with both fingerprints present.
4. `primary_fp` matches the baseline's `primary_fp` **exactly**.
5. `guard_fp` matches the baseline's `guard_fp` **exactly**.
6. `primary_pct > metric_tolerance` (PROGRAM.md currently sets this to
   `0.01`, so >1% primary improvement required).
7. `guard_pct > -3%` (guard must not regress more than 3%).

Any other outcome is `no_improvement`.

## Ground truth

- Evaluation function: `.polyresearch/bench.mjs` (and
  `.polyresearch/parse-metric.mjs` for extraction).
- Primary corpus: `scripts/top-cookie.json` — 14 real top-site `Cookie`
  header values, obfuscated per the repo's existing conventions (see
  `scripts/update-benchmark.js`).
- Guard corpus: `scripts/top-set-cookie.json` — 14 domains, 38 real
  `Set-Cookie` lines, same obfuscation.
- Correctness: the parser must produce the same output for every corpus
  entry as the baseline. This is enforced two ways:
  1. The sha256 fingerprints in the harness (fast, at-submit check).
  2. The existing vitest snapshot suites at `src/parse-cookie.spec.ts` and
     `src/parse-set-cookie.spec.ts` (slow, thorough, run by `npm test`).
- Why the evaluator is frozen: if the evaluator is editable, agents can
  win by making the scoring easier instead of making the code faster.

## Environment

- Node 18+ (tested on Node 22 and Node 25).
- Plain `node` for the harness — no test runner dependency at bench time.
  Vitest is only invoked during `npm test`.
- macOS/arm64 and Linux/x64 both work. Results are only comparable on the
  same machine in the same session; the protocol handles this by having
  each contributor run their own baseline alongside their candidate.
