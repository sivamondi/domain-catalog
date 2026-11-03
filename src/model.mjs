// Loads a catalog directory into an in-memory model and resolves its relationships.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import semver from 'semver';

export const COLLECTIONS = {
  domains: 'domain',
  systems: 'system',
  services: 'service',
  agents: 'agent',
  events: 'event',
  commands: 'command',
  queries: 'query',
  channels: 'channel',
  flows: 'flow',
  entities: 'entity',
  datastores: 'datastore',
  datasets: 'dataset',
  diagrams: 'diagram',
  adrs: 'adr',
};

export const TYPE_META = {
  domain: { plural: 'domains', label: 'Domain', labelPlural: 'Domains', color: '#f59e0b' },
  system: { plural: 'systems', label: 'System', labelPlural: 'Systems', color: '#0ea5e9' },
  service: { plural: 'services', label: 'Service', labelPlural: 'Services', color: '#ec4899' },
  agent: { plural: 'agents', label: 'Agent', labelPlural: 'Agents', color: '#8b5cf6' },
  event: { plural: 'events', label: 'Event', labelPlural: 'Events', color: '#f97316' },
  command: { plural: 'commands', label: 'Command', labelPlural: 'Commands', color: '#3b82f6' },
  query: { plural: 'queries', label: 'Query', labelPlural: 'Queries', color: '#22c55e' },
  channel: { plural: 'channels', label: 'Channel', labelPlural: 'Channels', color: '#64748b' },
  flow: { plural: 'flows', label: 'Flow', labelPlural: 'Flows', color: '#14b8a6' },
  entity: { plural: 'entities', label: 'Entity', labelPlural: 'Entities', color: '#a855f7' },
  datastore: { plural: 'datastores', label: 'Data store', labelPlural: 'Data stores', color: '#06b6d4' },
  dataset: { plural: 'datasets', label: 'Dataset', labelPlural: 'Datasets', color: '#84cc16' },
  diagram: { plural: 'diagrams', label: 'Diagram', labelPlural: 'Diagrams', color: '#78716c' },
  adr: { plural: 'adrs', label: 'ADR', labelPlural: 'ADRs', color: '#eab308' },
  team: { plural: 'teams', label: 'Team', labelPlural: 'Teams', color: '#10b981' },
  user: { plural: 'users', label: 'User', labelPlural: 'Users', color: '#6366f1' },
  actor: { plural: 'actors', label: 'Actor', labelPlural: 'Actors', color: '#475569' },
  external: { plural: 'externals', label: 'External', labelPlural: 'Externals', color: '#94a3b8' },
};

const MESSAGE_TYPES = new Set(['event', 'command', 'query']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.domaincatalog', 'public', 'rules']);
const NON_ASSET_DIRS = new Set([...Object.keys(COLLECTIONS), 'history', 'pages']);

const isDoc = (name) => /\.mdx?$/.test(name);
const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name), visit);
    } else if (entry.isFile()) {
      visit(path.join(dir, entry.name));
    }
  }
}

function readDoc(file, warnings) {
  try {
    const parsed = matter(fs.readFileSync(file, 'utf8'), {});
    return { data: parsed.data || {}, body: parsed.content || '' };
  } catch (error) {
    warnings.push(`${file}: invalid frontmatter (${error.message.split('\n')[0]})`);
    return null;
  }
}

function classify(rel) {
  const parts = rel.split('/');
  parts.pop();
  const versionedAt = parts.lastIndexOf('history');
  const dirParts = versionedAt >= 0 ? parts.slice(0, versionedAt) : parts;
  // guides/ and pages/ hold free-form documentation, never catalog resources.
  if (dirParts[0] === 'guides' || dirParts.includes('pages')) return null;
  const collection = dirParts[dirParts.length - 2];
  const type = COLLECTIONS[collection];
  if (!type) return null;
  return { type, isVersioned: versionedAt >= 0 };
}

function listAssets(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!NON_ASSET_DIRS.has(entry.name) && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        listAssets(path.join(dir, entry.name), base, out);
      }
    } else if (!isDoc(entry.name)) {
      out.push(toPosix(path.relative(base, path.join(dir, entry.name))));
    }
  }
  return out;
}

function listResourceDocs(dir) {
  const docsDir = path.join(dir, 'pages');
  if (!fs.existsSync(docsDir)) return [];
  const docs = [];
  walk(docsDir, (file) => {
    if (isDoc(file)) docs.push(file);
  });
  return docs.sort();
}

function loadRoot(root, source, catalog) {
  const { warnings } = catalog;
  walk(root, (file) => {
    const rel = toPosix(path.relative(root, file));
    const name = path.basename(file);
    if (/^(teams|users)\//.test(rel) && isDoc(name)) {
      const doc = readDoc(file, warnings);
      if (!doc) return;
      const type = rel.startsWith('teams/') ? 'team' : 'user';
      const id = doc.data.id ?? name.replace(/\.mdx?$/, '');
      catalog.resources.push({ ...doc.data, id: String(id), name: doc.data.name || String(id), type, version: null, isLatest: true, body: doc.body, file, dir: path.dirname(file), root, source, assets: [], docs: [] });
      return;
    }
    if (rel.startsWith('guides/') && isDoc(name)) {
      const doc = readDoc(file, warnings);
      if (doc) catalog.customDocs.push({ ...doc.data, slug: rel.replace(/^guides\//, '').replace(/\.mdx?$/, '').replace(/\/index$/, ''), body: doc.body, file, root, source });
      return;
    }
    if (rel.startsWith('site/') && isDoc(name)) {
      const doc = readDoc(file, warnings);
      if (doc) catalog.pages.push({ ...doc.data, slug: rel.replace(/^site\//, '').replace(/\.mdx?$/, '').replace(/\/index$/, ''), body: doc.body, file, root, source });
      return;
    }
    if (name !== 'resource.mdx' && name !== 'resource.md') return;
    const kind = classify(rel);
    if (!kind) return;
    const doc = readDoc(file, warnings);
    if (!doc) return;
    if (doc.data.id === undefined || doc.data.id === null) {
      warnings.push(`${rel}: missing id, skipped`);
      return;
    }
    const dir = path.dirname(file);
    const changelog = ['changes.mdx', 'changes.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    catalog.resources.push({
      ...doc.data,
      id: String(doc.data.id),
      version: doc.data.version === undefined ? null : String(doc.data.version),
      name: doc.data.name || String(doc.data.id),
      type: kind.type,
      isVersioned: kind.isVersioned,
      body: doc.body,
      file,
      dir,
      root,
      source,
      assets: listAssets(dir),
      docs: listResourceDocs(dir).map((docFile) => {
        const page = readDoc(docFile, warnings);
        return page && { ...page.data, slug: toPosix(path.relative(path.join(dir, 'pages'), docFile)).replace(/\.mdx?$/, ''), body: page.body, file: docFile };
      }).filter(Boolean),
      changelog: changelog ? readDoc(changelog, warnings) : null,
      mtime: fs.statSync(file).mtime,
    });
  });
}

// Fetches git-based sources into the project cache and returns local paths.
function resolveSources(root, config) {
  const sources = [{ path: root, name: 'local' }];
  for (const source of config.sources || []) {
    if (source.path) {
      sources.push({ path: path.resolve(root, source.path), name: source.name || source.path, prefix: source.prefix });
    } else if (source.git) {
      const name = source.name || source.git.replace(/[^a-zA-Z0-9]+/g, '-');
      const target = path.join(root, '.domaincatalog', 'sources', name);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        execFileSync('git', ['clone', '--depth', '1', ...(source.branch ? ['--branch', source.branch] : []), '--', source.git, target], { stdio: 'inherit' });
      } else if (source.pull !== false) {
        execFileSync('git', ['-C', target, 'pull', '--ff-only', '--quiet'], { stdio: 'inherit' });
      }
      sources.push({ path: source.dir ? path.join(target, source.dir) : target, name });
    }
  }
  return sources;
}

const pointerKey = (type, id, version) => `${type}:${id}:${version ?? ''}`;

export function resourceKey(r) {
  return pointerKey(r.type, r.id, r.version);
}

function compareVersions(a, b) {
  const va = semver.coerce(a);
  const vb = semver.coerce(b);
  if (va && vb) return semver.compare(va, vb);
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
}

function finalize(catalog) {
  const byId = new Map();
  const seen = new Map();
  catalog.resources = catalog.resources.filter((r) => {
    const key = resourceKey(r);
    if (seen.has(key)) {
      catalog.conflicts.push({ key, kept: seen.get(key).file, dropped: r.file });
      return false;
    }
    seen.set(key, r);
    return true;
  });
  for (const r of catalog.resources) {
    const key = `${r.type}:${r.id}`;
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(r);
  }
  for (const versions of byId.values()) {
    versions.sort((a, b) => compareVersions(b.version, a.version));
    const current = versions.find((v) => !v.isVersioned) || versions[0];
    for (const v of versions) {
      v.isLatest = v === current;
      v.versions = versions;
    }
  }
  catalog.byId = byId;
  catalog.latest = catalog.resources.filter((r) => r.isLatest);
}

const findVersion = (versions, requested) => {
  if (!requested || requested === 'latest') return versions.find((v) => v.isLatest);
  const exact = versions.find((v) => v.version === String(requested));
  if (exact) return exact;
  const range = semver.validRange(String(requested));
  if (range) {
    const match = versions.find((v) => semver.coerce(v.version) && semver.satisfies(semver.coerce(v.version), range));
    if (match) return match;
  }
  return null;
};

export function createResolver(catalog) {
  const resolve = (type, pointer) => {
    if (!pointer) return null;
    const id = typeof pointer === 'string' ? pointer : pointer.id;
    const requested = typeof pointer === 'string' ? null : pointer.version;
    const types = type === 'message' ? [...MESSAGE_TYPES] : Array.isArray(type) ? type : [type];
    for (const candidate of types) {
      const versions = catalog.byId.get(`${candidate}:${id}`);
      if (versions) {
        const found = findVersion(versions, requested);
        if (found) return found;
      }
    }
    return null;
  };
  return resolve;
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// Builds typed edges between latest-or-pinned resource versions.
function buildRelations(catalog) {
  const resolve = createResolver(catalog);
  catalog.resolve = resolve;
  const edges = [];
  const broken = [];
  const add = (from, to, label, kind) => {
    if (from && to && from !== to) edges.push({ from, to, label, kind });
  };
  const target = (owner, type, pointer) => {
    const found = resolve(type, pointer);
    if (!found) broken.push({ from: resourceKey(owner), file: owner.file, type, pointer: typeof pointer === 'string' ? pointer : pointer?.id, version: pointer?.version });
    return found;
  };

  for (const r of catalog.resources) {
    for (const pointer of asArray(r.publishes)) {
      const message = target(r, 'message', pointer);
      add(r, message, 'publishes', 'message');
      for (const channel of asArray(pointer?.to)) add(message, target(r, 'channel', channel), 'routed to', 'channel');
    }
    for (const pointer of asArray(r.consumes)) {
      const message = target(r, 'message', pointer);
      add(message, r, 'consumed by', 'message');
      for (const channel of asArray(pointer?.from)) add(target(r, 'channel', channel), message, 'delivers', 'channel');
    }
    for (const pointer of asArray(r.writes)) add(r, target(r, 'datastore', pointer), 'writes to', 'data');
    for (const pointer of asArray(r.reads)) add(target(r, 'datastore', pointer), r, 'read by', 'data');
    for (const pointer of asArray(r.inputs)) add(target(r, [...MESSAGE_TYPES, 'datastore', 'service', 'dataset'], pointer), r, 'input', 'data');
    for (const pointer of asArray(r.outputs)) add(r, target(r, [...MESSAGE_TYPES, 'datastore', 'service', 'dataset'], pointer), 'output', 'data');
    for (const pointer of asArray(r.dependsOn)) {
      if (pointer?.id) add(r, target(r, 'system', pointer), pointer.label || pointer.description || 'uses', 'system');
    }
    const contains = { domains: 'domain', systems: 'system', services: 'service', agents: 'agent', entities: 'entity', flows: 'flow', datastores: 'datastore', 'datasets': 'dataset', datasets: 'dataset', channels: 'channel' };
    r.children = [];
    if (r.type === 'domain' || r.type === 'system') {
      for (const [field, childType] of Object.entries(contains)) {
        for (const pointer of asArray(r[field])) {
          const child = target(r, childType, pointer);
          if (child) r.children.push(child);
        }
      }
      for (const pointer of [...asArray(r.publishes), ...asArray(r.consumes)]) {
        const message = resolve('message', pointer);
        if (message && !r.children.includes(message)) r.children.push(message);
      }
    }
    if (r.type === 'service' || r.type === 'agent') {
      for (const pointer of asArray(r.entities)) {
        add(r, target(r, 'entity', pointer), 'manages', 'entity');
      }
      for (const pointer of asArray(r.flows)) add(r, target(r, 'flow', pointer), 'participates in', 'flow');
    }
    if (r.type === 'entity') {
      for (const property of asArray(r.properties)) {
        if (property?.refersTo) add(r, resolve('entity', property.refersTo), property.name, 'entity');
      }
    }
    for (const pointer of asArray(r.concerns)) {
      const applied = resolve([...Object.values(COLLECTIONS)], pointer);
      if (applied) add(r, applied, 'applies to', 'adr');
    }
    r.ownerRefs = asArray(r.ownedBy).map((owner) => {
      const id = typeof owner === 'string' ? owner : owner?.id;
      return resolve(['team', 'user'], id) || { id, name: id, type: 'external', unresolved: true };
    });
  }

  // Summaries appear in tables and metadata, where reference syntax should read as plain names.
  for (const r of catalog.resources) {
    if (typeof r.summary === 'string' && r.summary.includes('{{')) {
      r.summary = r.summary.replace(/\{\{\s*([a-z-]+):([^}|\n]+?)(?:\|([^}\n]+))?\s*\}\}/g, (_, kind, id, label) => label || resolve(kind, id.split('@')[0])?.name || id);
    }
  }

  // Parent links from both frontmatter lists and folder nesting.
  for (const r of catalog.resources) r.parents = [];
  for (const r of catalog.resources) for (const child of r.children) if (!child.parents.includes(r)) child.parents.push(r);
  const byDir = new Map(catalog.resources.filter((r) => !r.isVersioned).map((r) => [r.dir, r]));
  for (const r of catalog.resources) {
    if (r.type === 'team' || r.type === 'user') continue;
    let dir = path.dirname(r.isVersioned ? r.dir.split(`${path.sep}history${path.sep}`)[0] : r.dir);
    while (dir.length > r.root.length) {
      const parent = byDir.get(dir);
      if (parent && parent !== r) {
        if (!r.parents.includes(parent)) r.parents.push(parent);
        if (!parent.children) parent.children = [];
        if (!parent.children.includes(r) && r.isLatest) parent.children.push(r);
        break;
      }
      dir = path.dirname(dir);
    }
  }

  catalog.edges = edges;
  catalog.broken = broken;
  catalog.outgoing = new Map();
  catalog.incoming = new Map();
  for (const edge of edges) {
    if (!catalog.outgoing.has(edge.from)) catalog.outgoing.set(edge.from, []);
    if (!catalog.incoming.has(edge.to)) catalog.incoming.set(edge.to, []);
    catalog.outgoing.get(edge.from).push(edge);
    catalog.incoming.get(edge.to).push(edge);
  }
  catalog.owned = new Map();
  for (const r of catalog.latest) {
    for (const owner of r.ownerRefs) {
      if (owner.unresolved) continue;
      if (!catalog.owned.has(owner)) catalog.owned.set(owner, []);
      catalog.owned.get(owner).push(r);
    }
  }
}

export function loadCatalog(root, config = {}) {
  const catalog = { root, config, resources: [], customDocs: [], pages: [], warnings: [], conflicts: [] };
  const sources = resolveSources(root, config);
  for (const source of sources) {
    if (!fs.existsSync(source.path)) {
      catalog.warnings.push(`source not found: ${source.path}`);
      continue;
    }
    loadRoot(source.path, source.name, catalog);
  }
  catalog.sources = sources;
  finalize(catalog);
  buildRelations(catalog);
  return catalog;
}

export const isMessage = (r) => MESSAGE_TYPES.has(r.type);

export const producersOf = (catalog, r) => (catalog.incoming.get(r) || []).filter((e) => e.label === 'publishes').map((e) => e.from);
export const consumersOf = (catalog, r) => (catalog.outgoing.get(r) || []).filter((e) => e.label === 'consumed by').map((e) => e.to);

export function messagesOf(catalog, r) {
  const publishes = (catalog.outgoing.get(r) || []).filter((e) => e.label === 'publishes').map((e) => e.to);
  const consumes = (catalog.incoming.get(r) || []).filter((e) => e.label === 'consumed by').map((e) => e.from);
  return { publishes, consumes };
}

// Every latest resource nested under a domain or system, across levels.
export function descendants(r, seen = new Set()) {
  for (const child of r.children || []) {
    if (!seen.has(child)) {
      seen.add(child);
      descendants(child, seen);
    }
  }
  return [...seen];
}
