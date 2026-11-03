// Runs architecture rules written as *.rule.mjs files in the catalog.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { consumersOf, descendants, messagesOf, producersOf } from './model.mjs';
import { writeFile } from './util.mjs';

export const defineRule = (definition) => definition;

const SKIPPED = new Set(['node_modules', 'dist', 'public']);

export function discoverRules(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.') && !entry.name.startsWith('dist.next')) walk(path.join(dir, entry.name));
      } else if (/\.rule\.m?js$/.test(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

// Rules only read the catalog; the array copies keep them from changing what later rules see.
function readOnlyView(catalog) {
  return {
    resources: (type) => catalog.latest.filter((r) => !type || r.type === type),
    allVersions: (type) => catalog.resources.filter((r) => !type || r.type === type),
    get: (type, id, version) => catalog.resolve(type, { id, version }),
    producersOf: (r) => producersOf(catalog, r),
    consumersOf: (r) => consumersOf(catalog, r),
    messagesOf: (r) => messagesOf(catalog, r),
    descendants: (r) => descendants(r),
    outgoing: (r) => [...(catalog.outgoing.get(r) || [])],
    incoming: (r) => [...(catalog.incoming.get(r) || [])],
    ownedBy: (owner) => [...(catalog.owned.get(owner) || [])],
  };
}

const normalize = (result) => (Array.isArray(result) ? result : result ? [result] : []).map((v) => (typeof v === 'string' ? { message: v } : v));

// A rule default-exports { id, title, severity, check({ catalog }) } and returns its violations.
export async function runRules(catalog) {
  const view = readOnlyView(catalog);
  const results = [];
  const seen = new Set();
  for (const file of discoverRules(catalog.root)) {
    const relative = path.relative(catalog.root, file);
    const base = { file: relative };
    try {
      const { default: rule } = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      if (typeof rule?.check !== 'function' || !rule.id) throw new Error('must default-export an object with an id and a check function');
      if (seen.has(rule.id)) throw new Error(`duplicate rule id "${rule.id}"`);
      seen.add(rule.id);
      const severity = rule.severity === 'warn' ? 'warn' : 'error';
      const violations = normalize(await rule.check({ catalog: view }));
      results.push({ ...base, id: rule.id, title: rule.title || rule.id, severity, status: !violations.length ? 'passed' : severity === 'warn' ? 'warning' : 'failed', violations });
    } catch (error) {
      // A rule that cannot run must never look like a rule that passed.
      results.push({ ...base, id: relative, title: relative, severity: 'error', status: 'errored', violations: [{ message: error.message }] });
    }
  }
  const count = (status) => results.filter((r) => r.status === status).length;
  return { evaluatedAt: new Date().toISOString(), summary: { total: results.length, passed: count('passed'), warnings: count('warning'), failed: count('failed'), errored: count('errored') }, results };
}

export function writeRulesReport(root, report) {
  const file = path.join(root, '.domaincatalog', 'rules', 'results.json');
  writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

export function formatRules(report) {
  const lines = [];
  for (const r of report.results) {
    if (r.status === 'passed') continue;
    lines.push(`${r.status.toUpperCase()} ${r.title} (${r.file})`);
    for (const v of r.violations) lines.push(`  - ${v.message}`);
  }
  const { total, passed, warnings, failed, errored } = report.summary;
  lines.push(`${total} rules: ${passed} passed, ${warnings} warnings, ${failed} failed, ${errored} errored`);
  return lines.join('\n');
}
