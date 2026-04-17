# Research program

This is the research playbook. It tells agents what to optimize, what they can
touch, and what constraints to respect. Read this before every experiment.

required_confirmations: 1
metric_tolerance: 0.01
metric_direction: lower_is_better
lead_github_login: alanzabihi
maintainer_github_login: alanzabihi
auto_approve: true
assignment_timeout: 24h
review_timeout: 12h
min_queue_depth: 5
max_queue_depth: 10
cli_version: 0.4.1

## Goal

Make `cookie` measurably faster at **parsing inbound `Cookie` request
headers**, reported in **ns per call** (equivalent to ms per 1 million calls)
and **percent improvement** against the baseline branch (`upstream/master`).

- Primary workload: `parseCookie(value)` over the real top-sites `Cookie`
  corpus at `scripts/top-cookie.json` (14 domains, realistic multi-cookie
  request headers). This is what servers run on every request.
- Guard workload: `parseSetCookie(value)` over the real top-sites
  `Set-Cookie` corpus at `scripts/top-set-cookie.json` (14 domains, 38
  set-cookie lines). This is a different code path but shares the hot helpers
  (`valueSlice`, `endIndex`, `eqIndex`, `decode`), so it catches regressions
  in shared parser machinery.
- Metric name: `ns_per_call_median` on the primary workload (lower is
  better). Equivalently, `ms_per_million_calls_median` — same number,
  different units, reported both ways.
- Reports must include the delta in milliseconds and percent against the
  baseline on the same machine, same `.polyresearch/bench.mjs` config, in the
  same run.

### Why this split

`cookie` has four public entry points: `parseCookie`, `stringifyCookie`,
`parseSetCookie`, `stringifySetCookie`. For real HTTP servers the highest-
volume operation is parsing the incoming `Cookie` request header — every
single request triggers it, often on long, multi-cookie strings (the top-sites
corpus averages ~500+ characters per header). Serialization is typically
one-shot per response. That makes `parseCookie` the right primary target.

`parseSetCookie` is the natural guard: it shares the same helpers
(`valueSlice`, `endIndex`, `eqIndex`, `decode`), so any change to those
helpers shows up in both metrics. If a candidate wins on the primary while
badly regressing the guard, it is almost certainly a correctness-agnostic
micro-optimization specialised to one input shape, and should be rejected.

Both corpora are real data that already ships in the repo and is already
used by the in-tree vitest benches and spec snapshots. We deliberately do
NOT invent synthetic workloads.

### Guard tolerance

- Guard regression tolerance: **3%**. A candidate must not make the guard
  workload more than 3% slower than the baseline. Larger guard regressions
  are hard rejects regardless of the primary improvement.
- A candidate that improves the primary by <1% is not worth submitting
  (within noise).

## What you CAN modify

Only the smallest set of files that can plausibly move the primary metric:

```
src/index.ts
```

That is the entire editable surface. Everything else in the repo is off-
limits for optimization edits.

## What you CANNOT modify

Everything not in the CAN list, and in particular:

- `src/*.spec.ts`, `src/__snapshots__/**` — the correctness contract.
- `src/*.bench.ts`, `benchmarks/**` — the in-tree vitest benches.
- `scripts/top-cookie.json`, `scripts/top-set-cookie.json` — the evaluation
  corpora. Changing these would invalidate comparisons.
- `.polyresearch/**` — the harness, the metric extractor, any setup script.
- `PREPARE.md`, `POLYRESEARCH.md`, `PROGRAM.md` — protocol files.
- `package.json`, `package-lock.json`, `tsconfig*.json`, `.github/**` —
  build, test, CI configuration.
- `dist/**` — generated output. It is rebuilt from `src/index.ts` before
  every evaluation.
- No new runtime or dev dependencies. Implementations must stand on what
  Node built-ins and the TypeScript type system already provide.

## Constraints

Every item below is a hard reject if violated.

- **Public API and types are frozen.** `parseCookie`, `stringifyCookie`,
  `parseSetCookie`, `stringifySetCookie`, their option shapes, and the
  backward-compat exports (`parse`, `serialize`) must keep the exact
  signatures published at v1.1.1.
- **RFC accept/reject behavior must not change.** All 198 existing tests,
  including the top-sites snapshot suites for both parsers, must pass
  unchanged. `__snapshots__/*.snap` are not editable.
- **100% line coverage must be preserved** (currently 100% stmts / funcs /
  lines, 97.72% branch). `npm test` wires this in via vitest v8 coverage.
- **Bundle size budget:** `npm run size` must stay under the published
  `size-limit` of 1.5 KB brotlied, minified. The v1.1.1 baseline is 1.39 KB,
  so there is ~110 bytes of headroom. `npm test` runs `npm run size` as part
  of the gate.
- **TypeScript strict build must pass** (`tsc --noEmit --project
  tsconfig.json` and `tsc --build` for dist). Included in `npm test`.
- **Prettier formatting must pass** (`ts-scripts test` invokes prettier on
  all tracked files except `.prettierignore`). Included in `npm test`.
- **No new dependencies**, runtime or dev. `package.json` is not editable.
- **Guard regression tolerance: 3%.** See above.
- **Side effects: none.** `package.json` declares `sideEffects: false`.
  Implementation must remain side-effect-free at module load (the
  `NullObject` IIFE is already tagged `@__PURE__`).
- **Evaluation variance.** If `ns_per_call_stdev / ns_per_call_median > 0.03`
  on either workload, rerun with a longer `POLYRESEARCH_MIN_MEASURE_MS`
  before submitting. See PREPARE.md.

## Strategy

Starting ideas, not prescriptions. Deviate when the code tells you to.

- The hot helpers `valueSlice`, `endIndex`, `eqIndex`, `decode` are called
  once per cookie pair and once per set-cookie attribute. Small
  improvements there compound across both workloads.
- `decode` already short-circuits when `indexOf("%") === -1`. On real
  corpora most values have no `%`; this path dominates. Confirm before
  optimizing it.
- `parseSetCookie` currently does `attr.toLowerCase()` on every attribute
  name and switches on the result. Attribute names in real traffic are
  usually cased loosely but drawn from a small vocabulary — worth probing.
- The `NullObject` pattern is a known V8-friendly way to build a map
  without prototype chain pollution. Don't regress that.
- The name/value regex tests in the stringify paths are not on the primary
  hot path but are reachable from the guard (no, they're stringify-only —
  don't touch them unless you can show the primary metric moves).
- Avoid micro-optimizations that overfit the current 14-domain corpus. Real
  HTTP servers see a much wider distribution; any change that makes a
  different shape of input quadratically slower is a regression even if
  this corpus happens to win.
- Known dead ends will accumulate here as the project progresses. Read
  `results.tsv` and issue annotations before proposing anything.
