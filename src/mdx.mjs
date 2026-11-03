// Renders catalog MDX without executing it: JSX tags map onto the built-in component set.
import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import yaml from 'js-yaml';
import { TYPE_META, descendants, messagesOf, producersOf, consumersOf, isMessage } from './model.mjs';
import { egoGraph, entityGraph, renderGraph } from './graph.mjs';
import { renderFlow } from './flow.mjs';
import { escapeHtml as h, slugify } from './util.mjs';

const highlight = (code, lang) => {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
  } catch {
    // Unknown grammars fall through to plain escaping.
  }
  return h(code);
};

export const codeBlock = (code, lang, title) => `<div class="dc-code">${title ? `<div class="dc-code-title">${h(title)}</div>` : ''}<button type="button" class="dc-copy" aria-label="Copy code">Copy</button><pre><code class="hljs">${highlight(code, lang)}</code></pre></div>`;

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const [language, ...rest] = (lang || '').split(/\s+/);
      if (language === 'mermaid') return `<pre class="mermaid">${h(text)}</pre>`;
      const title = rest.join(' ').match(/title="([^"]+)"/)?.[1];
      return codeBlock(text, language, title);
    },
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      return `<h${depth} id="${slugify(html)}">${html}</h${depth}>\n`;
    },
    table(token) {
      const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
      const rows = token.rows.map((row) => `<tr>${row.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
      return `<div class="dc-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

function parseAttributeValue(raw) {
  const text = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^(["'`]).*\1$/s.test(text)) return text.slice(1, -1);
  try {
    return yaml.load(text); // Flow-style YAML covers JSON and unquoted-key objects, never evaluates code.
  } catch {
    return text;
  }
}

// Scans an opening JSX tag starting at `<`; returns its name, attributes and end offset.
export function parseTag(source, start) {
  const name = /^<([A-Z][A-Za-z0-9.]*)/.exec(source.slice(start))?.[1];
  if (!name) return null;
  let i = start + name.length + 1;
  const attrs = {};
  while (i < source.length) {
    while (/\s/.test(source[i])) i += 1;
    if (source[i] === '/' && source[i + 1] === '>') return { name, attrs, end: i + 2, selfClosing: true };
    if (source[i] === '>') return { name, attrs, end: i + 1, selfClosing: false };
    const key = /^[A-Za-z_][\w:-]*/.exec(source.slice(i))?.[0];
    if (!key) return null;
    i += key.length;
    if (source[i] !== '=') {
      attrs[key] = true;
      continue;
    }
    i += 1;
    const open = source[i];
    if (open === '"' || open === "'") {
      const close = source.indexOf(open, i + 1);
      if (close < 0) return null;
      attrs[key] = source.slice(i + 1, close);
      i = close + 1;
    } else if (open === '{') {
      let depth = 0;
      let j = i;
      let quote = null;
      for (; j < source.length; j += 1) {
        const c = source[j];
        if (quote) {
          if (c === quote && source[j - 1] !== '\\') quote = null;
        } else if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth += 1;
        else if (c === '}' && (depth -= 1) === 0) break;
      }
      attrs[key] = parseAttributeValue(source.slice(i + 1, j));
      i = j + 1;
    } else {
      return null;
    }
  }
  return null;
}

function findClose(source, name, from) {
  const pattern = new RegExp(`<${name}(?=[\\s/>])|</${name}\\s*>`, 'g');
  pattern.lastIndex = from;
  let depth = 1;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return { start: m.index, end: m.index + m[0].length };
    } else {
      const tag = parseTag(source, m.index);
      if (tag && !tag.selfClosing) depth += 1;
    }
  }
  return null;
}

const dedent = (text) => {
  const lines = text.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
};

const ADMONITION_ALIASES = { tip: 'tip', note: 'note', info: 'note', warning: 'warning', caution: 'warning', danger: 'danger', error: 'danger' };

// Code is stashed first so tags inside fences and inline code stay literal.
function stashCode(source) {
  const stash = [];
  const replace = (match) => {
    stash.push(match);
    return `\u0001${stash.length - 1}\u0001`;
  };
  const text = source.replace(/^( *)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1?\s*\2[ \t]*$/gm, replace).replace(/`[^`\n]+`/g, replace);
  return { text, restore: (value) => value.replace(/\u0001(\d+)\u0001/g, (_, i) => stash[Number(i)]) };
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function table(columns, rows) {
  if (!rows.length) return '<p class="muted">None documented.</p>';
  return `<div class="dc-table-wrap"><table><thead><tr>${columns.map((c) => `<th>${h(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export const typeBadge = (type) => {
  const meta = TYPE_META[type] || TYPE_META.external;
  return `<span class="dc-type" style="--c:${meta.color}">${h(meta.label)}</span>`;
};

function schemaTree(schema, required = []) {
  if (!schema || typeof schema !== 'object') return '';
  const properties = schema.properties || schema.items?.properties;
  if (!properties) return '';
  const requiredList = schema.required || schema.items?.required || required;
  return `<ul class="dc-schema-tree">${Object.entries(properties).map(([name, prop]) => {
    const type = Array.isArray(prop?.type) ? prop.type.join(' | ') : prop?.type || (prop?.$ref ? prop.$ref.split('/').pop() : prop?.enum ? 'enum' : 'any');
    const nested = schemaTree(prop);
    const enumValues = prop?.enum ? `<div class="dc-schema-enum">${prop.enum.map((v) => `<code>${h(v)}</code>`).join(' ')}</div>` : '';
    const head = `<code class="dc-schema-name">${h(name)}</code> <span class="dc-schema-type">${h(type)}${prop?.format ? ` · ${h(prop.format)}` : ''}</span>${requiredList.includes(name) ? ' <span class="dc-schema-req">required</span>' : ''}`;
    const desc = prop?.description ? `<div class="dc-schema-desc">${h(prop.description)}</div>` : '';
    return nested ? `<li><details open><summary>${head}</summary>${desc}${enumValues}${nested}</details></li>` : `<li>${head}${desc}${enumValues}</li>`;
  }).join('')}</ul>`;
}

export function renderSchema(content, fileName, title, ctx) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  let parsed = null;
  try {
    if (ext === 'json' || ext === 'avsc') parsed = JSON.parse(content);
    else if (ext === 'yaml' || ext === 'yml') parsed = yaml.load(content);
  } catch {
    parsed = null;
  }
  const tree = parsed ? schemaTree(parsed) : '';
  const lang = { avsc: 'json', yml: 'yaml', proto: 'protobuf', graphql: 'graphql' }[ext] || ext;
  const href = ctx?.assetUrl ? ctx.assetUrl(fileName) : null;
  return `<section class="dc-schema">
    <header><strong>${h(title || fileName)}</strong>${href ? ` <a class="dc-btn" href="${h(href)}" download>Download</a>` : ''}</header>
    ${parsed?.description ? `<p>${h(parsed.description)}</p>` : ''}
    ${tree || ''}
    <details ${tree ? '' : 'open'}><summary>Raw ${h(ext || 'schema')}</summary>${codeBlock(content, lang)}</details>
  </section>`;
}

const COMPONENTS = {
  async Neighborhood(attrs, _inner, ctx) {
    const target = attrs.id ? ctx.catalog.resolve(attrs.type ? attrs.type : Object.keys(TYPE_META), { id: attrs.id, version: attrs.version }) : ctx.resource;
    if (!target) return attrs.id ? `<p class="muted">Unknown resource: ${h(attrs.id)}</p>` : '';
    if (target.type === 'flow') return COMPONENTS.FlowMap({ id: target.id }, '', ctx);
    return renderGraph(egoGraph(ctx.catalog, target, { depth: Number(attrs.depth) || 1 }), { url: ctx.url, title: attrs.title || target.name, height: Number(attrs.maxHeight) || 480 });
  },
  async FlowMap(attrs, _inner, ctx) {
    const flow = attrs.id ? ctx.catalog.resolve('flow', { id: attrs.id, version: attrs.version }) : ctx.resource;
    if (!flow) return `<p class="muted">Unknown flow: ${h(attrs.id)}</p>`;
    return renderFlow(ctx.catalog, flow, { url: ctx.url, height: Number(attrs.maxHeight) || 460, staticOnly: ctx.staticOutput });
  },
  async EntityRelations(attrs, _inner, ctx) {
    const owner = attrs.id ? ctx.catalog.resolve(['domain', 'system', 'service'], { id: attrs.id, version: attrs.version }) : ctx.resource;
    const entities = owner ? descendants(owner).filter((r) => r.type === 'entity') : ctx.catalog.latest.filter((r) => r.type === 'entity');
    return renderGraph(entityGraph(ctx.catalog, entities), { url: ctx.url, title: 'Entity map' });
  },
  SchemaView(attrs, _inner, ctx) {
    const base = ctx.resource?.dir;
    const file = attrs.file || ctx.resource?.schema;
    if (!base || !file) return '';
    const full = path.resolve(base, String(file));
    if (!full.startsWith(`${path.resolve(ctx.resource.root)}${path.sep}`) || !fs.existsSync(full)) return `<p class="muted">Schema not found: ${h(file)}</p>`;
    return renderSchema(fs.readFileSync(full, 'utf8'), String(file), attrs.title, ctx);
  },
  async MessageList(attrs, _inner, ctx) {
    const r = attrs.id ? ctx.catalog.resolve(['service', 'domain', 'agent', 'system'], { id: attrs.id, version: attrs.version }) : ctx.resource;
    if (!r) return '';
    const members = r.type === 'domain' || r.type === 'system' ? descendants(r).filter((c) => c.type === 'service' || c.type === 'agent') : [r];
    const rows = [];
    const seen = new Set();
    const format = attrs.format || 'all';
    for (const member of members) {
      const { publishes, consumes } = messagesOf(ctx.catalog, member);
      const groups = [...(format === 'consumes' ? [] : publishes.map((m) => [m, 'Publishes'])), ...(format === 'publishes' ? [] : consumes.map((m) => [m, 'Consumes']))];
      for (const [message, direction] of groups) {
        const key = `${message.type}:${message.id}:${direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push([`<a href="${h(ctx.url(message))}">${h(message.name)}</a>`, typeBadge(message.type), direction, message.version ? `v${h(message.version)}` : '', h((message.summary || '').trim())]);
      }
    }
    return table(['Message', 'Type', 'Direction', 'Version', 'Summary'], rows.slice(0, Number(attrs.limit) || undefined));
  },
  EntityFields(attrs, _inner, ctx) {
    const entity = attrs.id ? ctx.catalog.resolve('entity', { id: attrs.id, version: attrs.version }) : ctx.resource;
    const rows = asArray(entity?.properties).map((p) => {
      const ref = p.refersTo && ctx.catalog.resolve('entity', p.refersTo);
      return [`<code>${h(p.name)}</code>`, h(p.type), p.required ? 'Yes' : 'No', h(p.description), ref ? `<a href="${h(ctx.url(ref))}">${h(ref.name)}${p.refersToField ? `.${h(p.refersToField)}` : ''}</a>` : ''];
    });
    return table(['Property', 'Type', 'Required', 'Description', 'References'], rows);
  },
  ChannelDetails(_attrs, _inner, ctx) {
    const r = ctx.resource;
    if (r?.type !== 'channel') return '';
    const rows = [['Address', r.address ? `<code>${h(r.address)}</code>` : '—'], ['Protocols', asArray(r.protocols).map((p) => `<code>${h(p)}</code>`).join(' ') || '—'], ['Delivery guarantee', h(r.deliveryGuarantee || '—')]];
    const parameters = Object.entries(r.parameters || {}).map(([name, value]) => [`<code>${h(name)}</code>`, h(value?.description), asArray(value?.enum).map((e) => `<code>${h(e)}</code>`).join(' '), h(value?.default)]);
    return table(['Property', 'Value'], rows) + (parameters.length ? `<h4>Parameters</h4>${table(['Name', 'Description', 'Values', 'Default'], parameters)}` : '');
  },
  DecisionList(_attrs, _inner, ctx) {
    const adrs = ctx.catalog.latest.filter((r) => r.type === 'adr' && (!ctx.resource || ctx.resource.type === 'adr' || asArray(r.concerns).some((p) => p.id === ctx.resource.id)));
    return table(['Decision', 'Status', 'Summary'], adrs.map((r) => [`<a href="${h(ctx.url(r))}">${h(r.name)}</a>`, h(r.status), h(r.summary)]));
  },
  ToolList(_attrs, _inner, ctx) {
    return table(['Tool', 'Description'], asArray(ctx.resource?.tools).map((tool) => [`<code>${h(tool.name || tool.id)}</code>`, h(tool.description)]));
  },
  FieldList(attrs, inner, ctx) {
    return `<div class="dc-props">${attrs.title ? `<h4>${h(attrs.title)}</h4>` : ''}${inner}</div>`;
  },
  Field(attrs, inner) {
    return `<div class="dc-prop"><code>${h(attrs.name)}</code>${attrs.type ? ` <span class="dc-schema-type">${h(attrs.type)}</span>` : ''}${attrs.required ? ' <span class="dc-schema-req">required</span>' : ''}<div>${inner}</div></div>`;
  },
  Callout(attrs, inner) {
    const type = ADMONITION_ALIASES[attrs.type] || 'note';
    return `<aside class="dc-callout dc-callout-${type}" role="note"><strong>${h(attrs.title || type[0].toUpperCase() + type.slice(1))}</strong>${inner}</aside>`;
  },
  Grid(attrs, inner) { return `<div class="dc-columns" style="--cols:${Number(attrs.cols) || 2}">${inner}</div>`; },
  Cell(_a, inner) { return `<div>${inner}</div>`; },
  Cards(attrs, inner) { return `<div class="dc-cards" style="--cols:${Number(attrs.cols) || 3}">${inner}</div>`; },
  Card(attrs, inner, ctx) {
    const body = `<strong>${h(attrs.title)}</strong>${attrs.description ? `<p>${h(attrs.description)}</p>` : ''}${inner}`;
    return attrs.href ? `<a class="dc-card" href="${h(ctx.href(String(attrs.href)))}">${body}</a>` : `<div class="dc-card">${body}</div>`;
  },
  DisclosureGroup(_a, inner) { return `<div class="dc-disclosures">${inner}</div>`; },
  Disclosure(attrs, inner) { return `<details class="dc-disclosure"><summary>${h(attrs.title)}</summary>${inner}</details>`; },
  Procedure(_a, inner) { return `<ol class="dc-steps">${inner}</ol>`; },
  ProcedureStep(attrs, inner) { return `<li>${attrs.title ? `<strong>${h(attrs.title)}</strong>` : ''}${inner}</li>`; },
  CodeTabs(_a, inner) { return `<div class="dc-codetabs">${inner}</div>`; },
  PromptBlock(attrs, inner) { return `<div class="dc-prompt"><strong>${h(attrs.title || 'Prompt')}</strong><button type="button" class="dc-copy" aria-label="Copy prompt">Copy</button><div class="dc-prompt-body">${inner}</div></div>`; },
  Ref(attrs, inner, ctx) {
    const r = ctx.catalog.resolve(attrs.type ? attrs.type : Object.keys(TYPE_META), { id: attrs.id, version: attrs.version });
    return r ? `<a href="${h(ctx.url(r))}">${inner.replace(/<\/?p>/g, '') || h(r.name)}</a>` : `<span>${inner.replace(/<\/?p>/g, '') || h(attrs.id)}</span>`;
  },
  PageLink(attrs, inner, ctx) { return `<a href="${h(ctx.href(String(attrs.href || '#')))}">${inner.replace(/<\/?p>/g, '')}</a>`; },
  LinkList(_a, _i, ctx) {
    const items = asArray(ctx.resource?.attachments).map((a) => (typeof a === 'string' ? { url: a, title: a } : a));
    return table(['Attachment', 'Type', 'Description'], items.map((a) => [`<a href="${h(a.url)}" rel="noopener">${h(a.title || a.url)}</a>`, h(a.type), h(a.description)]));
  },
  SpecLink(attrs, _i, ctx) { return specLink(attrs, ctx, attrs.kind || 'API'); },
  MermaidFile(attrs, _i, ctx) {
    const full = path.resolve(ctx.resource?.dir || ctx.catalog.root, String(attrs.file || ''));
    return full.startsWith(path.resolve(ctx.catalog.root)) && fs.existsSync(full) ? `<pre class="mermaid">${h(fs.readFileSync(full, 'utf8'))}</pre>` : `<p class="muted">Mermaid file not found: ${h(attrs.file)}</p>`;
  },
  Embed: (a) => embed(a, a.url),
};

function specLink(attrs, ctx, kind) {
  return `<p><a class="dc-btn" href="${h(ctx.specUrl ? ctx.specUrl(attrs.file) : '#')}">View ${h(kind)} specification${attrs.file ? `: ${h(attrs.file)}` : ''}</a></p>`;
}

function embed(attrs, src) {
  if (!src || !/^https:\/\//.test(String(src))) return '<p class="muted">Embed needs an https url.</p>';
  return `<div class="dc-embed"><iframe src="${h(src)}" title="${h(attrs.title || 'Embedded diagram')}" height="${Number(attrs.height) || 500}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups"></iframe></div>`;
}

// Reads `frontmatter.a.b` without evaluating anything; only own data fields and array length resolve.
function frontmatterValue(ctx, dotted) {
  let value = ctx.resource;
  for (const key of dotted.split('.')) {
    if (value === null || value === undefined) return '';
    if (key === 'length' && Array.isArray(value)) value = value.length;
    else value = Object.prototype.hasOwnProperty.call(Object(value), key) ? value[key] : '';
  }
  return value ?? '';
}

const withoutOrderPrefix = (slug) => slug.split('/').map((part) => part.replace(/^\d+[-_]/, '')).join('/');
const encodePath = (slug) => slug.split('/').map(encodeURIComponent).join('/');

function findDoc(ctx, target) {
  const { catalog, resource } = ctx;
  const wanted = target.replace(/^\/+|\.mdx?$/g, '');
  const matches = (doc) => doc.slug === wanted || withoutOrderPrefix(doc.slug) === wanted || doc.id === wanted;
  const scopes = [resource, ...(resource?.parents || []), ...catalog.latest];
  for (const scope of scopes) {
    const doc = scope?.docs?.find(matches);
    if (doc) return { title: doc.title || doc.slug, summary: doc.summary, href: `${ctx.url(scope, true)}pages/${encodePath(doc.slug)}/` };
  }
  const custom = catalog.customDocs.find(matches);
  return custom ? { title: custom.title || custom.slug, summary: custom.summary, href: ctx.href(`guides/${encodePath(custom.slug)}/`) } : null;
}

const referenceLink = (name, title, href, type) => `<a class="dc-ref" data-type="${h(type)}" href="${h(href)}"${title ? ` title="${h(String(title).trim()).replace(/\|/g, '&#124;')}"` : ''}>${h(name)}</a>`;

// Expands {{type:id}}, {{type:id@version}} and {{type:id|Label}} into links; misses stay readable and are reported.
function expandReferences(fragment, ctx) {
  return fragment.replace(/\{\{\s*([a-z-]+):([^}|\n]+?)(?:\|([^}\n]+))?\s*\}\}/g, (raw, kind, target, label) => {
    const [id, version] = target.trim().split('@');
    const miss = () => {
      ctx.catalog.warnings.push(`unresolved reference ${raw}${ctx.resource ? ` in ${ctx.resource.type}:${ctx.resource.id}` : ''}`);
      return h(label || id);
    };
    if (kind === 'guide') {
      const doc = findDoc(ctx, target.trim());
      return doc ? referenceLink(label || doc.title, doc.summary, doc.href, 'guide') : miss();
    }
    if (kind === 'schema') {
      const message = ctx.catalog.resolve('message', { id: id.split('/').pop(), version });
      if (!message) return miss();
      return referenceLink(label || `${message.name} schema`, message.summary, ctx.href(`schemas/${TYPE_META[message.type].plural}/${encodeURIComponent(message.id)}/${encodeURIComponent(message.version ?? 'latest')}/`), 'schema');
    }
    if (kind === 'spec') {
      const parts = id.split('/');
      const owner = parts.length > 1 ? ctx.catalog.resolve(Object.keys(TYPE_META), parts[parts.length - 2]) : ctx.resource;
      return owner ? referenceLink(label || parts[parts.length - 1], owner.summary, `${ctx.url(owner, true)}specs/${encodeURIComponent(slugify(parts[parts.length - 1]))}/`, 'spec') : miss();
    }
    if (!TYPE_META[kind]) return miss();
    const r = ctx.catalog.resolve(kind, { id, version });
    return r ? referenceLink(label || r.name, r.summary, ctx.url(r, Boolean(version)), r.type) : miss();
  });
}

function resolveAttribute(value, restore, ctx) {
  if (typeof value !== 'string') return value;
  let text = restore(value);
  if (/^`.*`$/s.test(text)) text = text.slice(1, -1).replace(/\$\{\s*frontmatter\.([\w.]+)\s*\}/g, (_, key) => String(frontmatterValue(ctx, key)));
  const direct = /^frontmatter\.([\w.]+)$/.exec(text);
  return direct ? frontmatterValue(ctx, direct[1]) : text;
}

async function renderSegments(source, ctx) {
  const stashed = stashCode(source);
  const { restore } = stashed;
  const text = stashed.text.replace(/(?<!=)\{\s*frontmatter\.([\w.]+)\s*\}/g, (_, key) => h(frontmatterValue(ctx, key)));
  let out = '';
  let cursor = 0;
  const markdown = (fragment) => (fragment.trim() ? marked.parse(dedentIfIndented(restore(expandReferences(fragment, ctx)))) : '');
  const pattern = /<[A-Z][A-Za-z0-9.]*/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const tag = parseTag(text, m.index);
    if (!tag) continue;
    for (const key of Object.keys(tag.attrs)) tag.attrs[key] = resolveAttribute(tag.attrs[key], restore, ctx);
    const close = tag.selfClosing ? null : findClose(text, tag.name, tag.end);
    if (!tag.selfClosing && !close) continue;
    out += markdown(text.slice(cursor, m.index));
    const inner = close ? restore(text.slice(tag.end, close.start)) : '';
    const renderer = COMPONENTS[tag.name];
    if (renderer) {
      const innerHtml = inner ? await renderSegments(dedent(inner), ctx) : '';
      out += await renderer(tag.attrs, innerHtml, ctx);
    } else {
      // Unknown components keep their children so custom markup never drops content.
      if (ctx.unknown) ctx.unknown.add(tag.name);
      if (inner) out += await renderSegments(dedent(inner), ctx);
    }
    cursor = close ? close.end : tag.end;
    pattern.lastIndex = cursor;
  }
  out += markdown(text.slice(cursor));
  return out;
}

const dedentIfIndented = (text) => (/^\s{4,}\S/.test(text) ? dedent(text) : text);

export async function renderMdx(body, ctx) {
  const lines = String(body).split('\n');
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.startsWith(fence)) fence = null;
    }
    if (!fence && /^(import|export)\s.+/.test(line) && !/^\s/.test(line)) continue;
    kept.push(line);
  }
  const cleaned = kept.join('\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^:::(\w+)[ \t]*(.*)\n([\s\S]*?)^:::[ \t]*$/gm, (_, type, title, inner) => `<Callout type="${type}" title="${title.replace(/[\[\]"]/g, '')}">\n${inner}\n</Callout>`);
  return renderSegments(cleaned, ctx);
}

export { isMessage, producersOf, consumersOf };
