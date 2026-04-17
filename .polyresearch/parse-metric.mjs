#!/usr/bin/env node
// Parse the primary metric out of a bench log.
// Prints one number (primary ns/call median) on stdout.
// Usage: node .polyresearch/parse-metric.mjs run.log [primary|guard|primary_fp|guard_fp]

import { readFileSync } from "node:fs";

const logPath = process.argv[2];
const field = process.argv[3] ?? "primary";
if (!logPath) {
  console.error(
    "usage: parse-metric.mjs <log> [primary|guard|primary_fp|guard_fp]",
  );
  process.exit(2);
}

const text = readFileSync(logPath, "utf8");
const m = text.match(
  /=== POLYRESEARCH_RESULT_BEGIN ===\s*\n([\s\S]*?)\n=== POLYRESEARCH_RESULT_END ===/,
);
if (!m) {
  console.error("could not find POLYRESEARCH_RESULT block in log");
  process.exit(3);
}
const data = JSON.parse(m[1]);

switch (field) {
  case "primary":
    process.stdout.write(String(data.primary.ns_per_call_median));
    break;
  case "guard":
    process.stdout.write(String(data.guard.ns_per_call_median));
    break;
  case "primary_fp":
    process.stdout.write(data.primary.fingerprint);
    break;
  case "guard_fp":
    process.stdout.write(data.guard.fingerprint);
    break;
  default:
    console.error(`unknown field: ${field}`);
    process.exit(4);
}
