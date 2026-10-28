#!/usr/bin/env node
/**
 * audit-queue-state.js
 * 
 * Scan a continuation queue file and verify that "done" entries have real artifacts.
 * 
 * Usage: node audit-queue-state.js [queue-file-path]
 * Default: .qoder-work-queue.md in current directory
 * 
 * Exit codes:
 *   0 - all green
 *   1 - red entries detected
 *   2 - queue file not found or parse error
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const queueFile = process.argv[2] || '.qoder-work-queue.md';
const absQueue = path.resolve(queueFile);

if (!fs.existsSync(absQueue)) {
  console.error(`[QUEUE AUDIT] Queue file not found: ${absQueue}`);
  process.exit(2);
}

const content = fs.readFileSync(absQueue, 'utf-8');
const lines = content.split('\n');

const entries = [];
let currentEntry = null;

function extractArtifacts(text, entry) {
  const filePattern = /(?:^|\s)((?:[A-Za-z]:\/|\/|[.]{1,2}\/)[^\s]+\.[a-zA-Z0-9]+)/g;
  let m;
  while ((m = filePattern.exec(text)) !== null) {
    entry.files.push(m[1]);
  }
  
  const commitPattern = /\b([a-f0-9]{7,40})\b/g;
  while ((m = commitPattern.exec(text)) !== null) {
    entry.commits.push(m[1]);
  }
}

for (const line of lines) {
  const doneMatch = line.match(/^-\s*\[([xX])\]\s*(.+)$/);
  if (doneMatch) {
    if (currentEntry) entries.push(currentEntry);
    const text = doneMatch[2].trim();
    currentEntry = {
      status: 'done',
      text: text,
      line: line,
      files: [],
      commits: []
    };
    extractArtifacts(text, currentEntry);
    continue;
  }
  
  const todoMatch = line.match(/^-\s*\[\s*\]\s*(.+)$/);
  if (todoMatch) {
    if (currentEntry) entries.push(currentEntry);
    currentEntry = {
      status: 'todo',
      text: todoMatch[1].trim(),
      line: line,
      files: [],
      commits: []
    };
    continue;
  }
  
  if (currentEntry && currentEntry.status === 'done') {
    extractArtifacts(line, currentEntry);
  }
}

if (currentEntry) entries.push(currentEntry);

const doneEntries = entries.filter(e => e.status === 'done');

if (doneEntries.length === 0) {
  console.log(`[QUEUE AUDIT] ${new Date().toISOString()}`);
  console.log(`Scanning: ${queueFile}`);
  console.log(`\nNo "done" entries found.`);
  process.exit(0);
}

console.log(`[QUEUE AUDIT] ${new Date().toISOString()}`);
console.log(`Scanning: ${queueFile}`);
console.log(`Found ${doneEntries.length} "done" entries\n`);

const results = [];

for (const entry of doneEntries) {
  const checks = [];
  
  for (const file of entry.files) {
    const absFile = path.resolve(file);
    if (fs.existsSync(absFile)) {
      checks.push({ type: 'file', target: file, ok: true });
    } else {
      checks.push({ type: 'file', target: file, ok: false, reason: 'not found' });
    }
  }
  
  for (const commit of entry.commits) {
    try {
      execSync(`git cat-file -t ${commit}`, { stdio: 'pipe' });
      checks.push({ type: 'commit', target: commit, ok: true });
    } catch (e) {
      checks.push({ type: 'commit', target: commit, ok: false, reason: 'not in git' });
    }
  }
  
  if (checks.length === 0) {
    results.push({
      entry,
      status: 'red',
      reason: 'no verifiable artifact mentioned',
      checks: []
    });
  } else {
    const allOk = checks.every(c => c.ok);
    results.push({
      entry,
      status: allOk ? 'green' : 'red',
      reason: allOk ? 'all artifacts verified' : 'some artifacts missing',
      checks
    });
  }
}

let redCount = 0;
for (const r of results) {
  const icon = r.status === 'green' ? '\u2713' : '\u2717';
  const shortText = r.entry.text.substring(0, 60);
  console.log(`${icon} ${shortText}${r.entry.text.length > 60 ? '...' : ''}`);
  
  if (r.status === 'red') {
    redCount++;
    console.log(`  -> ${r.reason}`);
    for (const c of r.checks.filter(c => !c.ok)) {
      console.log(`    ${c.type}: ${c.target} (${c.reason})`);
    }
  }
}

console.log(`\n${redCount === 0 ? 'ALL GREEN' : `RED: ${redCount} / ${results.length} entries`}`);

process.exit(redCount > 0 ? 1 : 0);
