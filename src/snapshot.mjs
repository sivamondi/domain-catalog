// Point-in-time records of a catalog, and the differences between two of them.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resourceKey } from './model.mjs';
import { compareSchemas } from './breaking.mjs';

export const SNAPSHOT_DIR = path.join('.domaincatalog', 'snapshots');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function readSchema(r) {
  const file = r.schema ? String(r.schema) : r.assets?.find((a) => /^schema\./i.test(a));
  if (!file) return null;
  const full = path.resolve(r.dir, file);
  if (!full.startsWith(`${path.resolve(r.root)}${path.sep}`) || !fs.existsSync(full)) return null;
  const text = fs.readFileSync(full, 'utf8');
  let parsed = null;
  try {
    parsed = /\.ya?ml$/i.test(file) ? yaml.load(text) : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { file, hash: sha256(text), parsed };
}

export function createSnapshot(catalog, { label } = {}) {
  return {
    snapshotVersion: 1,
    createdAt: new Date().toISOString(),
    label: label || null,
    resources: catalog.latest.map((r) => ({
      key: resourceKey(r),
      type: r.type,
      id: r.id,
      version: r.version,
      name: r.name,
      ownedBy: r.ownerRefs.map((o) => o.id).sort(),
      deprecated: Boolean(r.deprecated),
      contentHash: sha256(fs.readFileSync(r.file, 'utf8')),
      schema: r.type === 'team' || r.type === 'user' ? null : readSchema(r),
    })),
    edges: catalog.edges.filter((e) => e.from.isLatest && e.to.isLatest).map((e) => ({ from: resourceKey(e.from), to: resourceKey(e.to), label: e.label })),
  };
}

export function writeSnapshot(root, snapshot) {
  const dir = path.join(root, SNAPSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${snapshot.createdAt.replace(/[:.]/g, '-')}.snapshot.json`);
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

export function listSnapshots(root) {
  const dir = path.join(root, SNAPSHOT_DIR);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.snapshot.json')).sort().map((f) => path.join(dir, f)) : [];
}

export const readSnapshot = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const logical = (r) => `${r.type}:${r.id}`;
const logicalKey = (key) => key.split(':').slice(0, 2).join(':');

// Resources match by type and id, so a version bump reads as a change rather than a replacement.
export function diffSnapshots(before, after, { mode = 'consumer' } = {}) {
  const left = new Map(before.resources.map((r) => [logical(r), r]));
  const right = new Map(after.resources.map((r) => [logical(r), r]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, r] of right) if (!left.has(key)) added.push(r);
  for (const [key, r] of left) if (!right.has(key)) removed.push(r);
  for (const [key, b] of right) {
    const a = left.get(key);
    if (!a) continue;
    const fields = [];
    if (a.version !== b.version) fields.push('version');
    if (a.name !== b.name) fields.push('name');
    if (a.ownedBy.join() !== b.ownedBy.join()) fields.push('owners');
    if (a.deprecated !== b.deprecated) fields.push('deprecated');
    if (a.contentHash !== b.contentHash) fields.push('content');
    if (a.schema?.hash !== b.schema?.hash) fields.push('schema');
    if (!fields.length) continue;
    const entry = { type: b.type, id: b.id, name: b.name, from: a.version, to: b.version, fields, ownersFrom: a.ownedBy, ownersTo: b.ownedBy };
    if (fields.includes('schema')) {
      entry.schemaChanges = a.schema?.parsed && b.schema?.parsed ? compareSchemas(a.schema.parsed, b.schema.parsed, { mode }) : { compatible: !a.schema, mode, changes: [], unknown: Boolean(a.schema && b.schema) };
    }
    changed.push(entry);
  }
  const edgeKey = (e) => `${logicalKey(e.from)}|${logicalKey(e.to)}|${e.label}`;
  const edgesA = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const edgesB = new Map(after.edges.map((e) => [edgeKey(e), e]));
  return {
    added: added.map(({ type, id, version, name }) => ({ type, id, version, name })),
    removed: removed.map(({ type, id, version, name }) => ({ type, id, version, name })),
    changed,
    edgesAdded: [...edgesB].filter(([k]) => !edgesA.has(k)).map(([, e]) => e),
    edgesRemoved: [...edgesA].filter(([k]) => !edgesB.has(k)).map(([, e]) => e),
  };
}

export function formatDiff(diff) {
  const lines = [];
  for (const r of diff.added) lines.push(`+ ${r.type} ${r.id} v${r.version}`);
  for (const r of diff.removed) lines.push(`- ${r.type} ${r.id} v${r.version}`);
  for (const r of diff.changed) {
    lines.push(`~ ${r.type} ${r.id} ${r.from === r.to ? `v${r.to}` : `v${r.from} -> v${r.to}`} (${r.fields.join(', ')})`);
    for (const c of r.schemaChanges?.changes || []) lines.push(`    ${c.breaking ? 'BREAKING ' : ''}${c.path}: ${c.message}`);
  }
  for (const e of diff.edgesAdded) lines.push(`+ link ${e.from} ${e.label} ${e.to}`);
  for (const e of diff.edgesRemoved) lines.push(`- link ${e.from} ${e.label} ${e.to}`);
  return lines.length ? lines.join('\n') : 'No changes';
}
