// Exports a whole catalog as a single HTML, Markdown or JSON file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPE_META, resourceKey } from './model.mjs';
import { renderMdx, typeBadge } from './mdx.mjs';
import { escapeHtml as h, slugify } from './util.mjs';

const ORDER = ['domain', 'system', 'service', 'agent', 'event', 'command', 'query', 'channel', 'flow', 'entity', 'datastore', 'dataset', 'diagram', 'adr', 'team', 'user'];
const CSS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client', 'app.css');
const anchor = (r) => `${r.type}-${slugify(r.id)}`;

export async function exportHtml(catalog) {
  const url = (r) => `#${anchor(r)}`;
  const ctx = { catalog, url, href: (p) => (/^(https?:|mailto:|#)/.test(p) ? p : '#'), unknown: new Set(), staticOutput: true };
  const sections = [];
  const toc = [];
  for (const type of ORDER) {
    const list = catalog.latest.filter((r) => r.type === type).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) continue;
    toc.push(`<li><a href="#section-${type}">${h(TYPE_META[type].labelPlural)}</a> <span class="muted">${list.length}</span></li>`);
    const items = [];
    for (const r of list) {
      const body = await renderMdx(r.body, { ...ctx, resource: r });
      const owners = r.ownerRefs.map((o) => (o.unresolved ? h(o.name) : `<a href="${url(o)}">${h(o.name)}</a>`)).join(', ');
      items.push(`<section id="${anchor(r)}" class="dc-export-item">
        <header class="dc-head">${typeBadge(r.type)}<h3>${h(r.name)}</h3>${r.version ? `<span class="muted">v${h(r.version)}</span>` : ''}</header>
        ${r.summary ? `<p class="dc-lead">${h(String(r.summary).trim())}</p>` : ''}
        ${owners ? `<p class="muted">Owners: ${owners}</p>` : ''}
        <div class="prose">${body}</div></section>`);
    }
    sections.push(`<h2 id="section-${type}">${h(TYPE_META[type].labelPlural)}</h2>${items.join('')}`);
  }
  const { config } = catalog;
  return `<!doctype html>
<html lang="en" data-theme-name="${h(config.theme || 'default')}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${h(config.title)} catalog</title>
<style>${fs.readFileSync(CSS, 'utf8')}
.dc-graph-toolbar { display: none; } .dc-graph-svg { height: auto; max-height: 560px; }
.dc-export-item { border-top: 1px solid var(--line); padding-top: 18px; margin-top: 22px; } .dc-export-item h3 { margin: 0; font-size: 1.3rem; }
.dc-copy { display: none; }
@media print { .dc-export-item { break-inside: avoid-page; } }</style></head>
<body><div class="dc-shell"><main class="dc-main"><h1>${h(config.title)}</h1><p class="dc-lead">Catalog reference. ${catalog.latest.length} resources.</p>
<nav aria-label="Contents"><ul class="dc-rail-list">${toc.join('')}</ul></nav>${sections.join('')}</main></div></body></html>`;
}

export function exportMarkdown(catalog) {
  const parts = [`# ${catalog.config.title}`];
  for (const type of ORDER) {
    const list = catalog.latest.filter((r) => r.type === type).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) continue;
    parts.push(`\n## ${TYPE_META[type].labelPlural}`);
    for (const r of list) {
      parts.push(`\n### ${r.name}${r.version ? ` (v${r.version})` : ''}`);
      if (r.summary) parts.push(`\n${String(r.summary).trim()}`);
      if (r.ownerRefs.length) parts.push(`\nOwners: ${r.ownerRefs.map((o) => o.name).join(', ')}`);
      parts.push(`\n${r.body.trim()}`);
    }
  }
  return `${parts.join('\n')}\n`;
}

export function exportJson(catalog) {
  return `${JSON.stringify({
    title: catalog.config.title,
    resources: catalog.resources.map((r) => ({
      key: resourceKey(r), type: r.type, id: r.id, version: r.version, name: r.name, summary: r.summary ?? null, latest: r.isLatest, ownedBy: r.ownerRefs.map((o) => o.id), documentation: r.body.trim(),
    })),
    relationships: catalog.edges.map((e) => ({ from: resourceKey(e.from), to: resourceKey(e.to), label: e.label })),
  }, null, 2)}\n`;
}

export const EXPORTERS = {
  html: { extension: 'html', run: exportHtml },
  markdown: { extension: 'md', run: exportMarkdown },
  json: { extension: 'json', run: exportJson },
};
