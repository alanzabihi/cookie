#!/usr/bin/env node
// Polyresearch evaluation harness for jshttp/cookie.
//
// Runs with plain `node`, no test runner. Consumes the built dist (built by
// `npm run build`, which runs tsc against tsconfig.build.json).
//
// Workloads:
//   primary  = parseCookie over the real top-sites Cookie corpus
//              (scripts/top-cookie.json, 14 domains)
//   guard    = parseSetCookie over the real top-sites Set-Cookie corpus
//              (scripts/top-set-cookie.json, 14 domains, 38 set-cookie lines)
//
// Both corpora already ship in the repo and are reused by the in-tree
// vitest benches — we deliberately do NOT invent synthetic data.
//
// Metrics:
//   primary_ns   = average nanoseconds per parseCookie call over the corpus
//   guard_ns     = average nanoseconds per parseSetCookie call over the corpus
//   primary_ms   = primary_ns rescaled to milliseconds per 1_000_000 calls
//   guard_ms     = guard_ns   rescaled to milliseconds per 1_000_000 calls
//   primary_fp   = sha256 over JSON.stringify of parsed outputs (per-call)
//   guard_fp     = sha256 over JSON.stringify of parsed outputs (per-call)
//
// The primary metric we report to polyresearch is primary_ms (lower is better).
// The guard metric is guard_ms (lower is better, with a tolerance set in
// PROGRAM.md). The fingerprints let reviewers confirm correctness without
// re-running the full snapshot suite.
//
// Timing methodology:
//   - Warmup: 3 passes over each corpus, results discarded.
//   - Measure: repeat each corpus pass until total elapsed >= MIN_MEASURE_MS
//     (default 2000 ms per workload); record ns per call.
//   - Repeat the whole measurement BATCH_COUNT times (default 7) and report
//     the median of batch means. Also print min/max/stdev so noise is visible.
//   - Use process.hrtime.bigint() for nanosecond resolution.
//
// Fingerprints:
//   - For each corpus entry, call the parser and hash JSON.stringify of the
//     result with a stable key order. Hash all results together per workload.
//   - The hash is independent of timing — it only validates that the editable
//     code still produces bit-identical output on the full corpus.
//
// Exit code is 0 on success, non-zero on crash.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const DIST_PATH = resolve(REPO_ROOT, "dist/index.js");
const TOP_COOKIE_PATH = resolve(REPO_ROOT, "scripts/top-cookie.json");
const TOP_SET_COOKIE_PATH = resolve(REPO_ROOT, "scripts/top-set-cookie.json");

const MIN_MEASURE_MS = Number(process.env.POLYRESEARCH_MIN_MEASURE_MS ?? 2000);
const BATCH_COUNT = Number(process.env.POLYRESEARCH_BATCH_COUNT ?? 7);
const WARMUP_PASSES = Number(process.env.POLYRESEARCH_WARMUP_PASSES ?? 3);

const mod = await import(DIST_PATH);
const { parseCookie, parseSetCookie } = mod;

if (typeof parseCookie !== "function" || typeof parseSetCookie !== "function") {
  console.error(
    "FAIL: dist/index.js does not export parseCookie/parseSetCookie",
  );
  process.exit(2);
}

const topCookie = JSON.parse(readFileSync(TOP_COOKIE_PATH, "utf8"));
const topSetCookie = JSON.parse(readFileSync(TOP_SET_COOKIE_PATH, "utf8"));

// Flatten corpora into arrays of strings for tight hot loops.
const cookieInputs = Object.values(topCookie);
const setCookieInputs = [];
for (const values of Object.values(topSetCookie)) {
  for (const v of values) setCookieInputs.push(v);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringify(value[k]));
  }
  return "{" + parts.join(",") + "}";
}

function fingerprint(parseFn, inputs) {
  const h = createHash("sha256");
  for (const input of inputs) {
    h.update(stableStringify(parseFn(input)));
    h.update("\n");
  }
  return h.digest("hex");
}

function measureWorkload(parseFn, inputs, minMs) {
  const minNs = BigInt(Math.round(minMs * 1e6));
  let elapsedNs = 0n;
  let calls = 0;
  let sink = 0;
  const start = process.hrtime.bigint();
  while (elapsedNs < minNs) {
    for (let i = 0; i < inputs.length; i++) {
      const r = parseFn(inputs[i]);
      if (r) sink++;
    }
    calls += inputs.length;
    elapsedNs = process.hrtime.bigint() - start;
  }
  if (sink < 0) console.log("");
  return Number(elapsedNs) / calls;
}

function warmup(parseFn, inputs) {
  let sink = 0;
  for (let p = 0; p < WARMUP_PASSES; p++) {
    for (let i = 0; i < inputs.length; i++) {
      const r = parseFn(inputs[i]);
      if (r) sink++;
    }
  }
  return sink;
}

function stats(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const median =
    n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const stdev = Math.sqrt(variance);
  return { median, min, max, mean, stdev };
}

function runWorkload(name, parseFn, inputs) {
  warmup(parseFn, inputs);
  const samples = [];
  for (let b = 0; b < BATCH_COUNT; b++) {
    samples.push(measureWorkload(parseFn, inputs, MIN_MEASURE_MS));
  }
  const s = stats(samples);
  const fp = fingerprint(parseFn, inputs);
  return {
    name,
    corpus_size: inputs.length,
    ns_per_call: s,
    ms_per_million_calls: {
      median: ((s.median / 1e6) * 1e6) / 1e3, // ns/call * 1e6 calls / 1e6 ns_per_ms = ns/call / 1 = ns/call... simplify below
    },
    fingerprint: fp,
    batches: samples,
  };
}

// ns/call * 1e6 calls = total ns for 1M calls. /1e6 ns_per_ms = total ms.
// => ms per 1M calls == ns/call.
// So ms_per_million_calls numerically equals ns_per_call. Report both
// explicitly for readability.

const primary = runWorkload(
  "parseCookie/top-cookie",
  parseCookie,
  cookieInputs,
);
const guard = runWorkload(
  "parseSetCookie/top-set-cookie",
  parseSetCookie,
  setCookieInputs,
);

function fmt(ns) {
  return ns.toFixed(2);
}

const out = {
  meta: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    min_measure_ms: MIN_MEASURE_MS,
    batch_count: BATCH_COUNT,
    warmup_passes: WARMUP_PASSES,
  },
  primary: {
    workload: primary.name,
    corpus_size: primary.corpus_size,
    ns_per_call_median: primary.ns_per_call.median,
    ns_per_call_min: primary.ns_per_call.min,
    ns_per_call_max: primary.ns_per_call.max,
    ns_per_call_stdev: primary.ns_per_call.stdev,
    ms_per_million_calls_median: primary.ns_per_call.median,
    fingerprint: primary.fingerprint,
    batches_ns: primary.batches,
  },
  guard: {
    workload: guard.name,
    corpus_size: guard.corpus_size,
    ns_per_call_median: guard.ns_per_call.median,
    ns_per_call_min: guard.ns_per_call.min,
    ns_per_call_max: guard.ns_per_call.max,
    ns_per_call_stdev: guard.ns_per_call.stdev,
    ms_per_million_calls_median: guard.ns_per_call.median,
    fingerprint: guard.fingerprint,
    batches_ns: guard.batches,
  },
};

console.log("=== polyresearch cookie bench ===");
console.log(`node: ${out.meta.node} ${out.meta.platform}/${out.meta.arch}`);
console.log(
  `batches: ${BATCH_COUNT}, min_measure_ms: ${MIN_MEASURE_MS}, warmup_passes: ${WARMUP_PASSES}`,
);
console.log("");
console.log(
  `PRIMARY: ${primary.name}  (corpus=${primary.corpus_size} strings)`,
);
console.log(
  `  ns/call  median=${fmt(primary.ns_per_call.median)}  min=${fmt(primary.ns_per_call.min)}  max=${fmt(primary.ns_per_call.max)}  stdev=${fmt(primary.ns_per_call.stdev)}`,
);
console.log(`  ms/1M    ${fmt(primary.ns_per_call.median)}`);
console.log(`  fingerprint ${primary.fingerprint}`);
console.log("");
console.log(`GUARD:   ${guard.name}  (corpus=${guard.corpus_size} strings)`);
console.log(
  `  ns/call  median=${fmt(guard.ns_per_call.median)}  min=${fmt(guard.ns_per_call.min)}  max=${fmt(guard.ns_per_call.max)}  stdev=${fmt(guard.ns_per_call.stdev)}`,
);
console.log(`  ms/1M    ${fmt(guard.ns_per_call.median)}`);
console.log(`  fingerprint ${guard.fingerprint}`);
console.log("");
console.log("=== POLYRESEARCH_RESULT_BEGIN ===");
console.log(JSON.stringify(out));
console.log("=== POLYRESEARCH_RESULT_END ===");
