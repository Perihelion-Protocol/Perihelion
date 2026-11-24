#!/usr/bin/env node
// Fail if the README "Implementation Status" table points a reader at a closed
// issue. A closed link reads as "this landed", which is the exact wrong signal
// for a table whose job is to say what is not implemented yet.
//
// A closed issue may still be referenced if the row annotates it, e.g.
// "tracked in #5 (closed, superseded by #328)" or
// "tracked in #723 (superseded by #942)".
//
// Usage: scripts/check-status-links.mjs [README.md]
//   GITHUB_TOKEN  optional; raises the API rate limit and is required for
//                 private repos. Without it the script still runs.
import fs from 'node:fs';
import process from 'node:process';

const readmePath = process.argv[2] ?? 'README.md';
const repo = process.env.GITHUB_REPOSITORY ?? 'Perihelion-Protocol/Perihelion';
const SECTION = '## Implementation Status';

const readme = fs.readFileSync(readmePath, 'utf8');
const start = readme.indexOf(SECTION);
if (start === -1) {
  console.error(`No "${SECTION}" section found in ${readmePath}`);
  process.exit(1);
}

// The section runs to the next top-level heading.
const rest = readme.slice(start + SECTION.length);
const end = rest.search(/\n## /);
const section = end === -1 ? rest : rest.slice(0, end);

const rows = section
  .split('\n')
  .filter((line) => line.trimStart().startsWith('|'))
  .filter((line) => !/^\s*\|[\s|:-]+\|\s*$/.test(line));

const references = [];
for (const row of rows) {
  const issueUrl = new RegExp(`https://github\\.com/${repo}/issues/(\\d+)`, 'g');
  for (const match of row.matchAll(issueUrl)) {
    references.push({ number: Number(match[1]), row });
  }
  for (const match of row.matchAll(/(?:^|[\s(])#(\d+)\b/g)) {
    references.push({ number: Number(match[1]), row });
  }
}

if (references.length === 0) {
  console.log('Implementation Status table references no issues.');
  process.exit(0);
}

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'perihelion-status-check',
};
if (process.env.GITHUB_TOKEN) {
  headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const seen = new Map();
const failures = [];

for (const { number, row } of references) {
  if (!seen.has(number)) {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
      headers,
    });
    if (!response.ok) {
      console.error(`::error::GitHub API returned ${response.status} for issue #${number}`);
      process.exit(1);
    }
    const issue = await response.json();
    seen.set(number, issue.state);
  }

  if (seen.get(number) !== 'closed') continue;

  // An annotated reference is deliberate and allowed.
  // Accept either "closed" or "superseded by" as valid annotations.
  const annotated = new RegExp(`#${number}[^|]{0,80}?\\b(closed|superseded by)\\b`, 'i').test(row);
  if (!annotated) {
    failures.push(number);
  }
}

if (failures.length > 0) {
  for (const number of [...new Set(failures)]) {
    console.error(
      `::error file=${readmePath}::Implementation Status links closed issue #${number}. ` +
        `Point at an open issue, or annotate it as "#${number} (closed, superseded by #N)" or "#${number} (superseded by #N)".`
    );
  }
  process.exit(1);
}

console.log(
  `Checked ${seen.size} issue reference(s) in the Implementation Status table; none are closed without annotation.`
);
