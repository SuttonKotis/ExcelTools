#!/usr/bin/env node
// Merge intake fragments (from tools/intake/intake.html) into the workbook CSVs.
//
//   node tools/intake/merge-fragments.mjs <fragment.csv...> [--apply] [--src <dir>] [--allow-downgrade]
//
// Fragments are an INBOX, not a database: this reads them, merges into the
// master tab CSVs, validates the merged result with convert-sheet.mjs --check
// in a temp dir, and only then (with --apply) writes the real files and renames
// each fragment to <name>.merged. Without --apply it is a dry run.
//
// Merge policy, per row (key: offering_id for Catalog, supplier for Suppliers):
//   • new key            → row appended
//   • existing key       → per-cell update:
//       – fragment cell blank                  → skipped (blank never clobbers)
//       – fragment TBD over a known value      → BLOCKED (downgrade) unless --allow-downgrade
//       – anything else that differs           → applied (old → new reported)
// Meta is never touched — bump data_version + changelog by hand after a merge.

import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CONVERTER = join(ROOT, 'tools', 'convert-sheet.mjs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALLOW_DOWNGRADE = args.includes('--allow-downgrade');
const srcIdx = args.indexOf('--src');
const SRC = srcIdx !== -1 ? args[srcIdx + 1] : join(ROOT, 'TechDocs', 'mock-sheet');
const fragments = args.filter((a, i) => !a.startsWith('--') && i !== srcIdx + 1);

if (!fragments.length) {
  console.error('usage: node tools/intake/merge-fragments.mjs <fragment.csv...> [--apply] [--src <dir>] [--allow-downgrade]');
  process.exit(2);
}

// ── CSV parse/serialize (same dialect as convert-sheet.mjs) ──
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const quote = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
const toCsv = (rows) => rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
const readTab = (dir, name) => parseCsv(readFileSync(join(dir, name), 'utf8').replace(/^﻿/, ''));

// ── Load master tabs; headers define the fragment contracts ──
const TABS = { Catalog: { key: 'offering_id' }, Suppliers: { key: 'supplier' } };
for (const [name, t] of Object.entries(TABS)) {
  const rows = readTab(SRC, `${name}.csv`);
  t.header = rows[0];
  t.rows = rows.slice(1);
  t.keyIdx = t.header.indexOf(t.key);
  t.touched = false;
}

// ── Merge each fragment ──
let blockedTotal = 0;
for (const frag of fragments) {
  console.log(`\n■ ${frag}`);
  const rows = parseCsv(readFileSync(frag, 'utf8').replace(/^﻿/, ''));
  const tabName = Object.keys(TABS).find((n) => TABS[n].header.join(',') === rows[0].join(','));
  if (!tabName) {
    console.error('  ✗ header matches neither Catalog nor Suppliers — not an intake fragment. Aborting.');
    process.exit(1);
  }
  const tab = TABS[tabName];
  const dataRows = rows.slice(1);
  if (!dataRows.length) { console.log('  (no data rows)'); continue; }

  for (const fr of dataRows) {
    while (fr.length < tab.header.length) fr.push('');
    const key = fr[tab.keyIdx];
    if (!key) { console.error(`  ✗ ${tabName} row with empty ${tab.key} — aborting.`); process.exit(1); }
    const existing = tab.rows.find((r) => r[tab.keyIdx] === key);

    if (!existing) {
      tab.rows.push(fr.slice(0, tab.header.length));
      tab.touched = true;
      console.log(`  NEW ${tabName} ${key}`);
      continue;
    }

    const applied = [], blocked = [];
    let blanks = 0;
    fr.forEach((v, i) => {
      if (i >= tab.header.length) return;
      const cur = existing[i] ?? '';
      if (v === cur) return;
      if (v === '') { blanks++; return; } // blank never clobbers
      if (v === 'TBD' && cur !== '' && cur !== 'TBD' && !ALLOW_DOWNGRADE) {
        blocked.push(`${tab.header[i]}: ${cur} -> TBD`);
        return;
      }
      applied.push(`${tab.header[i]}: ${cur || '(blank)'} -> ${v}`);
      existing[i] = v;
    });
    if (applied.length) tab.touched = true;
    blockedTotal += blocked.length;
    console.log(`  UPDATE ${tabName} ${key}: ${applied.length} cell(s)` +
      (applied.length ? ` [${applied.join(', ')}]` : '') +
      (blanks ? `; ${blanks} blank(s) skipped` : '') +
      (blocked.length ? `; ${blocked.length} downgrade(s) BLOCKED [${blocked.join(', ')}] (--allow-downgrade to force)` : ''));
  }
}

// ── Validate the merged result with the real converter, in a temp dir ──
const tmp = mkdtempSync(join(tmpdir(), 'kcp-merge-'));
for (const name of ['GarmentRules', 'ForcingRules', 'Meta']) copyFileSync(join(SRC, `${name}.csv`), join(tmp, `${name}.csv`));
for (const [name, t] of Object.entries(TABS)) writeFileSync(join(tmp, `${name}.csv`), toCsv([t.header, ...t.rows]));

const check = spawnSync(process.execPath, [CONVERTER, '--check', '--src', tmp], { encoding: 'utf8' });
process.stdout.write('\n' + check.stdout + (check.stderr || ''));
if (check.status !== 0) {
  console.error('✗ merged sheet FAILS validation — nothing written, no fragments archived.');
  process.exit(1);
}

// ── Apply or report ──
if (!APPLY) {
  console.log(`\n(dry run — re-run with --apply to write ${Object.entries(TABS).filter(([, t]) => t.touched).map(([n]) => `${n}.csv`).join(' + ') || 'nothing (no changes)'} and archive the fragments)`);
} else {
  for (const [name, t] of Object.entries(TABS)) {
    if (t.touched) { writeFileSync(join(SRC, `${name}.csv`), toCsv([t.header, ...t.rows])); console.log(`wrote ${join(SRC, `${name}.csv`)}`); }
  }
  for (const frag of fragments) {
    renameSync(frag, `${frag}.merged`);
    console.log(`archived ${basename(frag)} -> ${basename(frag)}.merged`);
  }
  console.log('\n⚠ remember: bump data_version + add a changelog line in Meta.csv, then run the full refresh (convert-sheet → test-engine).');
}
