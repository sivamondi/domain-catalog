// Programmatic API for reading and writing catalog files.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import semver from 'semver';
import { TYPE_META, loadCatalog } from './model.mjs';

const clean = (value) => JSON.parse(JSON.stringify(value));

// Ids and file names come from imported specs, so they must never escape their folder.
function safeSegment(value, label) {
  const text = String(value ?? '');
  if (!text || text === '.' || text === '..' || /[/\\\0]/.test(text)) throw new Error(`Invalid ${label}: "${text}"`);
  return text;
}

function safeRelativeFile(value) {
  const parts = String(value ?? '').split('/');
  parts.forEach((part) => safeSegment(part, 'file name'));
  return parts.join('/');
}

const isPerson = (type) => type === 'team' || type === 'user';

function assertType(type) {
  if (!TYPE_META[type] || type === 'actor' || type === 'external') throw new Error(`Unknown resource type: ${type}`);
}

const isNewer = (next, current) => {
  const [a, b] = [semver.coerce(next), semver.coerce(current)];
  return Boolean(a && b && semver.gt(a, b));
};

function toPlain(r) {
  const parsed = matter(fs.readFileSync(r.file, 'utf8'), {});
  return { ...parsed.data, markdown: parsed.content.trim(), path: r.file };
}

const stringify = ({ markdown = '', path: _path, ...frontmatter }) => matter.stringify(`\n${String(markdown).trim()}\n`, clean(frontmatter));

export function createSdk(root) {
  const catalogRoot = path.resolve(root);
  let cached = null;
  const catalog = () => {
    cached ??= loadCatalog(catalogRoot, {});
    return cached;
  };
  const changed = () => {
    cached = null;
  };
  const find = (type, id, version) => {
    assertType(type);
    return catalog().resolve(type, { id, version }) || null;
  };
  const require = (type, id, version) => {
    const r = find(type, id, version);
    if (!r) throw new Error(`${type} "${id}"${version ? ` version ${version}` : ''} not found`);
    return r;
  };

  // Moves a resource's own files into history/<version>; nested resources stay where they are.
  const archive = (type, id) => {
    const r = require(type, id);
    if (r.isVersioned) throw new Error(`${type} "${id}" has no current version to archive`);
    const target = path.join(r.dir, 'history', safeSegment(r.version, 'version'));
    if (fs.existsSync(target)) throw new Error(`Version ${r.version} of ${id} is already archived`);
    fs.mkdirSync(target, { recursive: true });
    const moved = [path.basename(r.file), 'changes.mdx', 'changes.md', ...r.assets.map((a) => a.split('/')[0])];
    for (const name of new Set(moved)) {
      const from = path.join(r.dir, name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(target, name));
    }
    changed();
    return target;
  };

  const write = (type, resource, { parent, override = false } = {}) => {
    assertType(type);
    const id = safeSegment(resource.id, 'id');
    if (isPerson(type)) {
      const file = path.join(catalogRoot, TYPE_META[type].plural, `${id}.mdx`);
      if (fs.existsSync(file) && !override) throw new Error(`${type} "${id}" already exists`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, stringify({ name: id, ...resource }));
      changed();
      return file;
    }
    const version = safeSegment(resource.version ?? '1.0.0', 'version');
    const existing = find(type, id);
    let dir;
    if (existing) {
      const pinned = existing.versions.find((v) => v.version === version);
      if (pinned && !override) throw new Error(`${type} "${id}" version ${version} already exists`);
      if (pinned) dir = pinned.dir;
      else {
        if (!isNewer(version, existing.version)) throw new Error(`${type} "${id}": version ${version} is older than the catalog's ${existing.version}`);
        dir = existing.isVersioned ? existing.dir.split(`${path.sep}history${path.sep}`)[0] : existing.dir;
        if (!existing.isVersioned) archive(type, id);
      }
    } else {
      let base = catalogRoot;
      if (parent) base = require(parent.type, parent.id, parent.version).dir;
      dir = path.join(base, TYPE_META[type].plural, id);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'resource.mdx'), stringify({ name: id, ...resource, version }));
    changed();
    return dir;
  };

  const update = (type, id, fields, version) => {
    const r = require(type, id, version);
    const current = toPlain(r);
    fs.writeFileSync(r.file, stringify({ ...current, ...fields }));
    changed();
  };

  const addFile = (type, id, { name, content }, version) => {
    const r = require(type, id, version);
    const target = path.join(r.dir, safeRelativeFile(name));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    changed();
    return target;
  };

  // Adds a pointer to a frontmatter list, replacing any earlier pointer to the same id.
  const addToList = (type, id, field, pointer, version) => {
    const current = toPlain(require(type, id, version));
    const list = (Array.isArray(current[field]) ? current[field] : []).filter((p) => (p?.id ?? p) !== (pointer?.id ?? pointer));
    update(type, id, { [field]: [...list, pointer] }, version);
  };

  return {
    root: catalogRoot,
    get: (type, id, version) => {
      const r = find(type, id, version);
      return r ? toPlain(r) : null;
    },
    list: (type, { latestOnly = true } = {}) => {
      assertType(type);
      return catalog().resources.filter((r) => r.type === type && (!latestOnly || r.isLatest)).map(toPlain);
    },
    versions: (type, id) => (find(type, id)?.versions || []).map((v) => v.version),
    locate: (type, id, version) => find(type, id, version)?.dir ?? null,
    write,
    update,
    archive,
    addFile,
    addToList,
    addSchema: (type, id, schema, { fileName = 'schema.json', version } = {}) => {
      addFile(type, id, { name: fileName, content: typeof schema === 'string' ? schema : `${JSON.stringify(schema, null, 2)}\n` }, version);
      update(type, id, { schema: fileName }, version);
    },
    addPublish: (type, id, pointer, version) => addToList(type, id, 'publishes', pointer, version),
    addConsume: (type, id, pointer, version) => addToList(type, id, 'consumes', pointer, version),
    addOwner: (type, id, owner, version) => addToList(type, id, 'ownedBy', owner, version),
    writeChanges: (type, id, markdown, version) => {
      const r = require(type, id, version);
      fs.writeFileSync(path.join(r.dir, 'changes.mdx'), `${String(markdown).trim()}\n`);
      changed();
    },
    writeGuide: (slug, { markdown = '', ...frontmatter }) => {
      const file = path.join(catalogRoot, 'guides', `${safeRelativeFile(slug)}.mdx`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, stringify({ markdown, ...frontmatter }));
      changed();
      return file;
    },
    writePage: (type, id, slug, { markdown = '', ...frontmatter }, version) => {
      const r = require(type, id, version);
      const file = path.join(r.dir, 'pages', `${safeRelativeFile(slug)}.mdx`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, stringify({ markdown, ...frontmatter }));
      changed();
    },
    // Deletes one resource. Nested resources must be removed first or passed through `force`.
    remove: (type, id, { version, force = false } = {}) => {
      const r = require(type, id, version);
      if (isPerson(type)) {
        fs.rmSync(r.file);
        changed();
        return;
      }
      const nested = catalog().resources.filter((other) => other !== r && other.dir.startsWith(`${r.dir}${path.sep}`) && !(other.type === r.type && other.id === r.id));
      if (nested.length && !force) throw new Error(`${type} "${id}" contains ${nested.length} other resources. Use force to remove them too.`);
      fs.rmSync(r.dir, { recursive: true });
      changed();
    },
  };
}

export default createSdk;
