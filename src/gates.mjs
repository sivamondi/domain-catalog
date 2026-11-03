// Applies gates from gates.yaml to the difference between two snapshots.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { diffSnapshots } from './snapshot.mjs';

const CONDITIONS = new Set(['resource_added', 'resource_removed', 'schema_changed', 'schema_breaking', 'owner_changed', 'deprecated', 'consumer_added', 'consumer_removed', 'producer_added', 'producer_removed']);

export function loadGates(root) {
  const file = ['gates.yaml', 'gates.yml'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (!file) throw new Error('No gates.yaml found in the catalog');
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const gates = doc?.gates;
  if (!Array.isArray(gates)) throw new Error('gates.yaml needs a "gates" list');
  for (const gate of gates) {
    if (!gate?.id) throw new Error('Each gate needs an id');
    for (const condition of [gate.when].flat()) {
      if (!CONDITIONS.has(condition)) throw new Error(`Gate ${gate.id}: unknown condition "${condition}". Use one of: ${[...CONDITIONS].join(', ')}`);
    }
    if (gate.severity && !['error', 'warn'].includes(gate.severity)) throw new Error(`Gate ${gate.id}: severity must be error or warn`);
  }
  return gates;
}

function events(diff, before, after) {
  const out = [];
  const add = (condition, type, id, message) => out.push({ condition, type, id, message });
  for (const r of diff.added) add('resource_added', r.type, r.id, `${r.type} ${r.id} was added`);
  for (const r of diff.removed) add('resource_removed', r.type, r.id, `${r.type} ${r.id} was removed`);
  const deprecatedBefore = new Set(before.resources.filter((r) => r.deprecated).map((r) => `${r.type}:${r.id}`));
  for (const r of after.resources) {
    if (r.deprecated && !deprecatedBefore.has(`${r.type}:${r.id}`)) add('deprecated', r.type, r.id, `${r.type} ${r.id} was deprecated`);
  }
  for (const c of diff.changed) {
    if (c.fields.includes('owners')) add('owner_changed', c.type, c.id, `${c.type} ${c.id} owners changed from [${c.ownersFrom}] to [${c.ownersTo}]`);
    if (c.fields.includes('schema')) {
      add('schema_changed', c.type, c.id, `${c.type} ${c.id} schema changed`);
      for (const change of c.schemaChanges?.changes || []) {
        if (change.breaking) add('schema_breaking', c.type, c.id, `${c.type} ${c.id} ${change.path}: ${change.message}`);
      }
    }
  }
  const split = (key) => key.split(':');
  const edge = (e, direction) => {
    const [fromType, fromId] = split(e.from);
    const [toType, toId] = split(e.to);
    if (e.label === 'consumed by') add(`consumer_${direction}`, fromType, fromId, `${toType} ${toId} ${direction === 'added' ? 'started' : 'stopped'} consuming ${fromId}`);
    if (e.label === 'publishes') add(`producer_${direction}`, toType, toId, `${fromType} ${fromId} ${direction === 'added' ? 'started' : 'stopped'} publishing ${toId}`);
  };
  diff.edgesAdded.forEach((e) => edge(e, 'added'));
  diff.edgesRemoved.forEach((e) => edge(e, 'removed'));
  return out;
}

export function checkGates(gates, before, after) {
  const diff = diffSnapshots(before, after);
  const happened = events(diff, before, after);
  const findings = [];
  for (const gate of gates) {
    const conditions = [gate.when].flat();
    const types = gate.types ? [gate.types].flat() : null;
    const ids = gate.ids ? [gate.ids].flat() : null;
    for (const event of happened) {
      if (conditions.includes(event.condition) && (!types || types.includes(event.type)) && (!ids || ids.includes(event.id))) {
        findings.push({ gate: gate.id, severity: gate.severity || 'error', message: gate.message ? `${gate.message}: ${event.message}` : event.message, type: event.type, id: event.id });
      }
    }
  }
  return { findings, errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warn').length, diff };
}
