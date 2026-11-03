// Validates catalog frontmatter, references and attached files.
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { consumersOf, isMessage, producersOf, resourceKey } from './model.mjs';

export const LINT_RULES = {
  'invalid-frontmatter': { severity: 'error', description: 'Frontmatter must parse, and resources need an id' },
  'duplicate-resource': { severity: 'error', description: 'A type, id and version may exist only once' },
  'broken-reference': { severity: 'error', description: 'Pointers must resolve to a resource in the catalog' },
  'unknown-owner': { severity: 'error', description: 'Owners must be teams or users in the catalog' },
  'unknown-member': { severity: 'error', description: 'Team members must be users in the catalog' },
  'missing-schema-file': { severity: 'error', description: 'schema must point at a file that exists' },
  'missing-spec-file': { severity: 'error', description: 'Specifications must point at files that exist' },
  'missing-version': { severity: 'error', description: 'Versioned resources need a version' },
  'invalid-version': { severity: 'warn', description: 'Versions should be semver' },
  'missing-summary': { severity: 'warn', description: 'Resources should have a summary' },
  'missing-owner': { severity: 'warn', description: 'Resources should have an owner' },
  'message-without-schema': { severity: 'warn', description: 'Messages should document their schema' },
  'message-without-producer': { severity: 'warn', description: 'Messages should have a producer' },
  'message-without-consumer': { severity: 'warn', description: 'Messages should have a consumer' },
};

const PEOPLE = new Set(['team', 'user']);
const OWNERLESS = new Set(['team', 'user', 'diagram']);

function specPaths(r) {
  if (!r.specs) return [];
  if (Array.isArray(r.specs)) return r.specs.map((s) => s.path);
  return Object.values(r.specs);
}

function inside(r, file) {
  const full = path.resolve(r.dir, String(file));
  return full.startsWith(`${path.resolve(r.root)}${path.sep}`) && fs.existsSync(full);
}

// `config.lint.rules` sets each rule to "off", "warn" or "error".
export function lintCatalog(catalog) {
  const overrides = catalog.config?.lint?.rules || {};
  const findings = [];
  const report = (rule, file, message) => {
    const severity = overrides[rule] ?? LINT_RULES[rule].severity;
    if (severity !== 'off') findings.push({ rule, severity, file: file ? path.relative(catalog.root, file) : null, message });
  };

  for (const warning of catalog.warnings) report('invalid-frontmatter', null, warning);
  for (const conflict of catalog.conflicts) report('duplicate-resource', conflict.dropped, `${conflict.key} is also defined in ${path.relative(catalog.root, conflict.kept)}`);
  for (const broken of catalog.broken) report('broken-reference', broken.file, `${broken.from} points at unknown ${Array.isArray(broken.type) ? 'resource' : broken.type} "${broken.pointer}"${broken.version ? ` version ${broken.version}` : ''}`);

  for (const r of catalog.resources) {
    const label = resourceKey(r);
    for (const owner of r.ownerRefs) if (owner.unresolved) report('unknown-owner', r.file, `${label} has unknown owner "${owner.id}"`);
    if (r.type === 'team') {
      for (const member of Array.isArray(r.members) ? r.members : []) {
        const id = member?.id ?? member;
        if (!catalog.resolve('user', id)) report('unknown-member', r.file, `Team ${r.id} has unknown member "${id}"`);
      }
    }
    if (!PEOPLE.has(r.type)) {
      if (!r.version) report('missing-version', r.file, `${label} has no version`);
      else if (!semver.valid(r.version) && !semver.valid(semver.coerce(r.version))) report('invalid-version', r.file, `${label} has a non-semver version`);
    }
    if (r.schema && !inside(r, r.schema)) report('missing-schema-file', r.file, `${label} schema not found: ${r.schema}`);
    for (const spec of specPaths(r)) if (!inside(r, spec)) report('missing-spec-file', r.file, `${label} specification not found: ${spec}`);
    if (!r.isLatest) continue;
    if (!PEOPLE.has(r.type) && !String(r.summary || '').trim()) report('missing-summary', r.file, `${label} has no summary`);
    if (!OWNERLESS.has(r.type) && !r.ownerRefs.length) report('missing-owner', r.file, `${label} has no owner`);
    if (isMessage(r)) {
      if (!r.schema && !r.assets.some((a) => /^schema\./i.test(a))) report('message-without-schema', r.file, `${label} has no schema`);
      if (!producersOf(catalog, r).length) report('message-without-producer', r.file, `${label} has no producer`);
      if (!consumersOf(catalog, r).length) report('message-without-consumer', r.file, `${label} has no consumer`);
    }
  }
  return {
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    checked: catalog.resources.length,
  };
}

export function formatLint(result) {
  const lines = result.findings.map((f) => `${f.severity === 'error' ? 'error' : 'warn '}  ${f.message}  [${f.rule}]${f.file ? `\n       ${f.file}` : ''}`);
  lines.push(`${result.checked} resources checked: ${result.errors} errors, ${result.warnings} warnings`);
  return lines.join('\n');
}
