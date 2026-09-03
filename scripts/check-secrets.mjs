#!/usr/bin/env node
/**
 * Pre-commit guard: refuse to commit secrets, credentials or personal data.
 *
 * This repo is destined to be public, and git history is effectively permanent
 * once pushed. The cost of a false positive is ten seconds; the cost of a false
 * negative is a credential or a home address on the internet forever. So this
 * fails closed and errs toward noise.
 *
 * It scans the *staged content* (not the working tree), so it cannot be fooled
 * by staging a clean version and then editing the file.
 *
 * Run manually:  npm run check:secrets
 * Bypass (only with a human's explicit say-so):  git commit --no-verify
 */
import { execFileSync } from "node:child_process";

/** Identities this project publishes under on purpose. */
const ALLOWED_EMAILS = new Set(["carlos@fathomforge.dev", "noreply@anthropic.com"]);

/** This file necessarily contains the patterns it looks for. */
const SELF = "scripts/check-secrets.mjs";

const RULES = [
  { name: "private key block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "OpenAI-style key", re: /\bsk-(?:live|proj|ant)?-?[A-Za-z0-9]{20,}\b/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  {
    name: "assigned credential",
    // KEY = "value" where the value looks like a real secret, not a placeholder.
    re: /\b(?:api[_-]?key|secret|passwd|password|token|credential)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
    skip: (line) => /(?:example|placeholder|redacted|your[_-]|xxx|\.\.\.|<[^>]+>|\$\{)/i.test(line),
  },
  {
    name: "GCP project id",
    re: /\b[a-z][a-z0-9-]{4,28}-\d{6}-[a-z0-9]{2}\b/,
  },
  {
    name: "Telegram chat id",
    // Group ids are large negative integers; user ids are 9-10 digit positives.
    re: /(?<![\w.-])-\d{10,}(?![\w.-])|(?<![\w.$-])\b\d{9,10}\b(?![\w.-])/,
    // Timestamps, byte counts, token counts and PRNG constants are the common
    // false positives. A real chat id does not appear next to arithmetic.
    skip: (line) =>
      /(?:tokens?|bytes?|ms\b|Date\.|_\d|\d_|epoch|timestamp|version|seed|random|prng|hash)/i.test(
        line,
      ) || /\d\s*[*%^]|[*%^]\s*\d/.test(line),
  },
  {
    name: "absolute home path",
    re: /(?:\/home\/[a-z][a-z0-9_-]*|\/Users\/[A-Za-z][A-Za-z0-9_-]*)\//,
    // Container and CI service accounts are identical on every install and
    // identify nobody, and documentation legitimately needs them (the OpenClaw
    // container really does run as `node`). A *personal* username in the same
    // position is still a finding.
    skip: (line) =>
      /(?:\/home\/(?:node|app|runner|root)\/|\/Users\/(?:runner|shared)\/)/.test(line) &&
      !/\/home\/(?!node\/|app\/|runner\/|root\/)[a-z]/.test(line) &&
      !/\/Users\/(?!runner\/|shared\/)[A-Za-z]/.test(line),
  },
  {
    name: "personal email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    skip: (line) => {
      const found = line.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? [];
      // Only complain about addresses that are not the project's public identity.
      return found.every((e) => ALLOWED_EMAILS.has(e.toLowerCase()));
    },
  },
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => f !== SELF);

const findings = [];

for (const file of staged) {
  let content;
  try {
    // `:file` reads the staged blob, not the working tree.
    content = git(["show", `:${file}`]);
  } catch {
    continue; // binary, deleted, or unreadable: nothing to scan
  }
  // A file containing a NUL byte cannot be scanned line by line -- but silently
  // skipping it would mean one stray byte exempts a file from this guard
  // entirely. That happened: a delimiter written as a raw NUL instead of an
  // escape turned a source file binary and removed it from this scan. Refuse
  // instead, and say why.
  if (content.includes("\u0000")) {
    findings.push({
      file,
      line: 1,
      rule: "unscannable binary content",
      text: "contains a NUL byte; cannot be scanned. Use an escape (\\u0000) instead of a raw byte.",
    });
    continue;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 2000) continue;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      if (rule.skip?.(line)) continue;
      findings.push({
        file,
        line: i + 1,
        rule: rule.name,
        text: line.trim().slice(0, 120),
      });
    }
  }
}

if (findings.length === 0) {
  console.log(`check-secrets: ${staged.length} staged file(s) clean.`);
  process.exit(0);
}

console.error("\ncheck-secrets: refusing to commit. Possible sensitive data:\n");
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  console.error(`    ${f.text}`);
}
console.error(
  "\nRemove it, or add the file to .gitignore and unstage it:\n" +
    "  git reset HEAD -- <file>\n" +
    "If this is a false positive, a human should confirm before using --no-verify.\n",
);
process.exit(1);
