// Generates the complete static site for a loaded catalog.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fse from 'fs-extra';
import yaml from 'js-yaml';
import { TYPE_META, consumersOf, descendants, isMessage, messagesOf, producersOf, resourceKey } from './model.mjs';
import { contextMap, egoGraph, fullGraph, renderGraph } from './graph.mjs';
import { renderFlow } from './flow.mjs';
import { codeBlock, renderMdx, renderSchema, typeBadge } from './mdx.mjs';
import { escapeHtml as h, slugify, writeFile } from './util.mjs';

const require = createRequire(import.meta.url);
const CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client');

const DISCOVER_TYPES = ['domain', 'system', 'service', 'agent', 'event', 'command', 'query', 'channel', 'flow', 'entity', 'datastore', 'dataset', 'diagram', 'adr'];
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const seg = (value) => encodeURIComponent(String(value));

export function createUrls(config) {
  const base = `/${String(config.base || '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const href = (p) => (/^(https?:|mailto:|#)/.test(p) ? p : `${base}${p.replace(/^\/+/, '')}`);
  const url = (r, version = false) => {
    if (r.type === 'team' || r.type === 'user') return href(`people/${TYPE_META[r.type].plural}/${seg(r.id)}/`);
    const plural = TYPE_META[r.type].plural;
    return href(`catalog/${plural}/${seg(r.id)}/${!version && r.isLatest ? '' : `${seg(r.version ?? 'latest')}/`}`);
  };
  return { base, href, url };
}

const ICON_PATHS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  overview: 'M5 4h5v5H5zM14 15h5v5h-5zM7.5 9v8.5H14M7.5 13H14',
  browse: 'M4 6h16M4 12h16M4 18h10',
  maps: 'M6 5a2 2 0 100 4 2 2 0 000-4zM18 15a2 2 0 100 4 2 2 0 000-4zM18 5a2 2 0 100 4 2 2 0 000-4zM8 7h8M18 9v6M7.5 8.5L16.5 15.5',
  schemas: 'M9 4H7a2 2 0 00-2 2v4l-2 2 2 2v4a2 2 0 002 2h2M15 4h2a2 2 0 012 2v4l2 2-2 2v4a2 2 0 01-2 2h-2',
  guides: 'M5 5a2 2 0 012-2h12v15H7a2 2 0 00-2 2zM5 20a2 2 0 002 2h12v-4',
  people: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 010 6.5M18 14.5c1.8.8 3 2.8 3 5.5',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
};

const icon = (name) => `<svg class="dc-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;

function sidebar(ctx, active, pagePath) {
  const { catalog, config, urls } = ctx;
  const here = decodeURIComponent(pagePath || urls.href('')).slice(urls.base.length);
  const section = /^(?:browse|catalog|schemas|maps)\/([a-z-]+)\//.exec(here)?.[1];
  const mark = (target, isCurrent) => (isCurrent ? ` aria-current="${here === target ? 'page' : 'true'}"` : '');
  const item = ([label, target, key, iconName]) => `<a class="dc-side-link" href="${h(urls.href(target))}" title="${h(label)}"${mark(target, key === active)}>${icon(iconName)}<span>${h(label)}</span></a>`;

  const types = DISCOVER_TYPES.map((type) => [type, catalog.latest.filter((r) => r.type === type).length]).filter(([, count]) => count);
  const browseList = types.map(([type, count]) => {
    const { plural, labelPlural } = TYPE_META[type];
    const target = `browse/${plural}/`;
    return `<li><a href="${h(urls.href(target))}"${mark(target, active === 'browse' && section === plural)}><span>${h(labelPlural)}</span><span class="dc-side-count">${count}</span></a></li>`;
  }).join('');
  const browse = `<a class="dc-side-link dc-side-rail-only" href="${h(urls.href('browse/services/'))}" title="Browse"${mark('browse/services/', active === 'browse')}>${icon('browse')}<span>Browse</span></a>
    <details class="dc-side-group dc-side-wide-only"${active === 'browse' ? ' open' : ''}><summary class="dc-side-link"${active === 'browse' ? ' data-active="true"' : ''}>${icon('browse')}<span>Browse</span></summary><ul>${browseList}</ul></details>`;

  const domains = catalog.latest.filter((r) => r.type === 'domain' && !r.parents.some((p) => p.type === 'domain')).sort((a, b) => a.name.localeCompare(b.name));
  const domainList = domains.length ? `<div class="dc-side-section dc-side-wide-only"><h2><a href="${h(urls.href('browse/domains/'))}"${mark('browse/domains/', here === 'browse/domains/')}>Domains</a></h2><ul>${domains.map((d) => {
    const target = decodeURIComponent(urls.url(d)).slice(urls.base.length);
    return `<li><a href="${h(urls.url(d))}"${mark(target, here.startsWith(target))}>${h(d.name)}</a></li>`;
  }).join('')}</ul></div>` : '';

  const before = [['Home', '', 'home', 'home'], ['Overview', 'overview/', 'overview', 'overview']];
  const after = [
    ['Maps', 'maps/', 'maps', 'maps'],
    ['Schemas', 'schemas/', 'schemas', 'schemas'],
    ...(catalog.customDocs.length ? [['Guides', 'guides/', 'guides', 'guides']] : []),
    ['People', 'people/teams/', 'people', 'people'],
    ...asArray(config.nav).map((p) => [p.label, p.href || p.url || '', p.label, 'link']),
  ];
  return `<aside id="dc-sidebar" class="dc-sidebar" aria-label="Site menu">
    <div class="dc-side-head"><span>Menu</span><button type="button" class="dc-side-close" aria-label="Close menu">${icon('close')}</button></div>
    <nav aria-label="Primary">${before.map(item).join('')}${browse}${after.map(item).join('')}</nav>
    ${domainList}
  </aside>`;
}

function layout(ctx, { title, body, active, description, wide, rail, pagePath }) {
  const { config, urls, dev } = ctx;
  const logo = config.logo?.src ? `<img src="${h(urls.href(config.logo.src))}" alt="" height="26"/>` : '';
  return `<!doctype html>
<html lang="en" data-theme-name="${h(config.theme)}">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${h(title)} · ${h(config.title)}</title>
<meta name="description" content="${h(description || config.tagline)}"/>
<link rel="icon" href="data:,"/>
<link rel="stylesheet" href="${urls.href('_dc/app.css')}"/>
${ctx.hasCustomCss ? `<link rel="stylesheet" href="${urls.href('_dc/custom.css')}"/>` : ''}
<link rel="alternate" type="text/plain" title="LLM index" href="${urls.href('llms.txt')}"/>
<script>try{var t=localStorage.getItem('dc-color');if(t)document.documentElement.dataset.color=t;if(localStorage.getItem('dc-sidebar')==='collapsed')document.documentElement.dataset.sidebar='collapsed'}catch(e){};if(new URLSearchParams(location.search).get('embed')==='true')document.documentElement.dataset.embed='true'</script>
</head>
<body data-base="${h(urls.base)}"${dev ? ' data-dev="true"' : ''}>
<a class="dc-skip" href="#main">Skip to content</a>
<header class="dc-top">
  <button type="button" class="dc-menu" aria-label="Toggle menu" aria-controls="dc-sidebar" aria-expanded="true">${icon('menu')}</button>
  <a class="dc-brand" href="${urls.href('')}">${logo}<span>${h(config.logo?.text || config.title)}</span></a>
  <button type="button" class="dc-search-open" aria-label="Search the catalog"><span>Search…</span><kbd>⌘K</kbd></button>
  <button type="button" class="dc-color" aria-label="Toggle dark mode">◐</button>
</header>
<div class="dc-frame">
  ${sidebar(ctx, active, pagePath)}
  <div class="dc-side-backdrop" hidden></div>
  <div class="dc-content">
    <div class="dc-shell${wide ? ' dc-wide' : ''}${rail ? ' dc-has-rail' : ''}">
      <main id="main" class="dc-main">${body}</main>
      ${rail ? `<aside class="dc-rail" aria-label="Details">${rail}</aside>` : ''}
    </div>
  </div>
</div>
<dialog class="dc-search" aria-label="Search"><input type="search" placeholder="Search services, messages, schemas, teams…" aria-label="Search query"/><ul class="dc-search-results"></ul></dialog>
<script src="${urls.href('_dc/app.js')}" defer></script>
</body></html>`;
}

const pageFile = (ctx, urlPath) => {
  const relative = urlPath.startsWith(ctx.urls.base) ? urlPath.slice(ctx.urls.base.length) : urlPath.replace(/^\//, '');
  return path.join(ctx.out, decodeURIComponent(relative), 'index.html');
};

const emit = (ctx, urlPath, opts) => writeFile(pageFile(ctx, urlPath), layout(ctx, { ...opts, pagePath: urlPath }));
const emitRaw = (ctx, relative, content) => writeFile(path.join(ctx.out, relative), content);

function labels(r) {
  return asArray(r.labels).map((b) => `<span class="dc-badge" style="--c:${h(cssColor(b.backgroundColor))}">${h(b.content)}</span>`).join('');
}

const cssColor = (value) => (/^[a-zA-Z]+$|^#[0-9a-fA-F]{3,8}$/.test(String(value)) ? String(value) : 'gray');

function resourceRows(ctx, list) {
  return list.map((r) => {
    const owners = (r.ownerRefs || []).map((o) => (o.unresolved ? h(o.name) : `<a href="${h(ctx.urls.url(o))}">${h(o.name)}</a>`)).join(', ');
    const parents = (r.parents || []).filter((p) => p.type === 'domain' || p.type === 'system' || p.type === 'service').map((p) => `<a href="${h(ctx.urls.url(p))}">${h(p.name)}</a>`).join(', ');
    return `<tr data-search="${h(`${r.name} ${r.id} ${r.summary || ''}`.toLowerCase())}" data-owner="${h((r.ownerRefs || []).map((o) => o.id).join(' '))}">
      <td><a href="${h(ctx.urls.url(r))}"><strong>${h(r.name)}</strong></a>${r.deprecated ? ' <span class="dc-flag dc-flag-warn">Deprecated</span>' : ''}${r.draft ? ' <span class="dc-flag">Draft</span>' : ''}</td>
      <td>${r.version ? `v${h(r.version)}` : ''}</td><td class="dc-summary">${h(String(r.summary || '').trim())}</td><td>${parents}</td><td>${owners}</td></tr>`;
  }).join('');
}

function renderDiscover(ctx) {
  const { catalog } = ctx;
  const tabs = (active) => `<nav class="dc-tabs" aria-label="Resource types">${DISCOVER_TYPES.map((type) => {
    const count = catalog.latest.filter((r) => r.type === type).length;
    return count ? `<a href="${ctx.urls.href(`browse/${TYPE_META[type].plural}/`)}"${type === active ? ' aria-current="page"' : ''}>${h(TYPE_META[type].labelPlural)} <span>${count}</span></a>` : '';
  }).join('')}</nav>`;
  for (const type of DISCOVER_TYPES) {
    const list = catalog.latest.filter((r) => r.type === type).sort((a, b) => a.name.localeCompare(b.name));
    const owners = [...new Map(list.flatMap((r) => r.ownerRefs || []).map((o) => [o.id, o])).values()];
    emit(ctx, ctx.urls.href(`browse/${TYPE_META[type].plural}/`), {
      title: TYPE_META[type].labelPlural,
      active: 'browse',
      wide: true,
      body: `<h1>Browse ${h(TYPE_META[type].labelPlural.toLowerCase())}</h1>${tabs(type)}
      <div class="dc-filters"><input type="search" class="dc-table-filter" placeholder="Filter ${h(TYPE_META[type].labelPlural.toLowerCase())}…" aria-label="Filter table"/>
      <select class="dc-owner-filter" aria-label="Filter by owner"><option value="">All owners</option>${owners.map((o) => `<option value="${h(o.id)}">${h(o.name)}</option>`).join('')}</select>
      <span class="dc-count muted">${list.length} results</span></div>
      <div class="dc-table-wrap"><table class="dc-sortable"><thead><tr><th>Name</th><th>Version</th><th>Summary</th><th>Part of</th><th>Owners</th></tr></thead><tbody>${resourceRows(ctx, list)}</tbody></table></div>`,
    });
  }
}

const linkList = (ctx, title, list) => (list.length ? `<section><h3>${h(title)} <span class="muted">${list.length}</span></h3><ul class="dc-rail-list">${list.map((r) => `<li><a href="${h(ctx.urls.url(r))}">${h(r.name)}</a> ${typeBadge(r.type)}</li>`).join('')}</ul></section>` : '');

function specsOf(r) {
  const raw = r.specs;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => ({ type: s.type, path: s.path, name: s.name || s.path }));
  return Object.entries(raw).map(([key, file]) => ({ type: key.replace(/Path$/, ''), path: file, name: file }));
}

const resourceBase = (ctx, r, version = false) => ctx.urls.url(r, version);

function assetUrl(ctx, r, file) {
  return ctx.urls.href(`assets/${TYPE_META[r.type].plural}/${seg(r.id)}/${seg(r.version ?? 'latest')}/${file.split('/').map(seg).join('/')}`);
}

function schemaFile(r) {
  if (r.schema) return String(r.schema);
  return r.assets?.find((a) => /^schema\./i.test(a)) || null;
}

function railFor(ctx, r) {
  const { catalog } = ctx;
  const parts = [];
  if (r.ownerRefs?.length) parts.push(`<section><h3>Owners</h3><ul class="dc-rail-list">${r.ownerRefs.map((o) => (o.unresolved ? `<li>${h(o.name)}</li>` : `<li><a href="${h(ctx.urls.url(o))}">${h(o.name)}</a> ${typeBadge(o.type)}</li>`)).join('')}</ul></section>`);
  if (isMessage(r)) {
    parts.push(linkList(ctx, 'Producers', producersOf(catalog, r)), linkList(ctx, 'Consumers', consumersOf(catalog, r)));
  }
  if (r.type === 'service' || r.type === 'agent') {
    const { publishes, consumes } = messagesOf(catalog, r);
    parts.push(linkList(ctx, 'Publishes', publishes), linkList(ctx, 'Consumes', consumes));
    const data = (catalog.outgoing.get(r) || []).filter((e) => e.kind === 'data').map((e) => e.to);
    const reads = (catalog.incoming.get(r) || []).filter((e) => e.kind === 'data').map((e) => e.from);
    parts.push(linkList(ctx, 'Data stores', [...new Set([...data, ...reads])]));
  }
  if (r.type === 'domain' || r.type === 'system') {
    const nested = descendants(r);
    for (const type of ['domain', 'system', 'service', 'agent', 'flow', 'entity', 'datastore']) {
      parts.push(linkList(ctx, TYPE_META[type].labelPlural, nested.filter((c) => c.type === type)));
    }
  }
  if (r.parents?.length) parts.push(linkList(ctx, 'Part of', r.parents));
  const adrs = catalog.latest.filter((a) => a.type === 'adr' && asArray(a.concerns).some((p) => p.id === r.id));
  parts.push(linkList(ctx, 'Decisions', adrs));
  const specs = specsOf(r);
  if (specs.length) parts.push(`<section><h3>Specifications</h3><ul class="dc-rail-list">${specs.map((s) => `<li><a href="${h(resourceBase(ctx, r, true))}specs/${seg(slugify(s.path))}/">${h(s.name)}</a> <span class="dc-flag">${h(s.type)}</span></li>`).join('')}</ul></section>`);
  const schema = schemaFile(r);
  if (schema) parts.push(`<section><h3>Schema</h3><ul class="dc-rail-list"><li><a href="${h(assetUrl(ctx, r, schema))}" download>${h(schema)}</a></li></ul></section>`);
  if (r.docs?.length) parts.push(`<section><h3>Documentation</h3><ul class="dc-rail-list">${r.docs.map((d) => `<li><a href="${h(resourceBase(ctx, r, true))}pages/${d.slug.split('/').map(seg).join('/')}/">${h(d.title || d.slug)}</a></li>`).join('')}</ul></section>`);
  if (r.repository?.url) parts.push(`<section><h3>Repository</h3><ul class="dc-rail-list"><li><a href="${h(r.repository.url)}" rel="noopener">${h(r.repository.url.replace(/^https?:\/\//, ''))}</a></li></ul></section>`);
  const actions = [`<a class="dc-btn" href="${ctx.urls.href(`maps/${TYPE_META[r.type].plural}/${seg(r.id)}/${seg(r.version ?? 'latest')}/`)}">Open map</a>`];
  if (r.changelog) actions.push(`<a class="dc-btn" href="${h(resourceBase(ctx, r, true))}changes/">Changes</a>`);
  actions.push(`<a class="dc-btn" href="${h(resourceBase(ctx, r, true))}index.md">Markdown</a>`);
  const relative = path.relative(r.root, r.file).split(path.sep).join('/');
  if (ctx.config.sourceUrl) actions.push(`<a class="dc-btn" href="${h(`${String(ctx.config.sourceUrl).replace(/\/$/, '')}/${relative}`)}" rel="noopener">Edit source</a>`);
  return `<div class="dc-actions">${actions.join('')}</div>${parts.join('')}`;
}

// Change notes and extra pages are only reachable through links, so flows keep them in the page.
function flowLinks(ctx, r) {
  const base = resourceBase(ctx, r, true);
  const links = [
    ...(r.changelog ? [`<a class="dc-btn" href="${h(base)}changes/">Changes</a>`] : []),
    ...r.docs.map((d) => `<a class="dc-btn" href="${h(base)}pages/${d.slug.split('/').map(seg).join('/')}/">${h(d.title || d.slug)}</a>`),
  ];
  return links.length ? `<div class="dc-actions">${links.join('')}</div>` : '';
}

function renderFlowSteps(ctx, r) {
  const steps = asArray(r.steps);
  if (!steps.length) return '';
  return `<h2 id="steps">Steps</h2><ol class="dc-steps">${steps.map((step) => {
    const linked = step.message ? ctx.catalog.resolve('message', step.message) : step.service ? ctx.catalog.resolve('service', step.service) : step.flow ? ctx.catalog.resolve('flow', step.flow) : null;
    return `<li><strong>${h(step.title || step.id)}</strong>${linked ? ` — <a href="${h(ctx.urls.url(linked))}">${h(linked.name)}</a> ${typeBadge(linked.type)}` : ''}${step.summary ? `<p>${h(step.summary)}</p>` : ''}</li>`;
  }).join('')}</ol>`;
}

async function renderResource(ctx, r) {
  const mdxCtx = {
    catalog: ctx.catalog, resource: r, url: ctx.urls.url, href: ctx.urls.href, unknown: ctx.unknown,
    assetUrl: (file) => assetUrl(ctx, r, file),
    specUrl: (file) => `${resourceBase(ctx, r, true)}specs/${seg(slugify(String(file || specsOf(r)[0]?.path || '')))}/`,
  };
  const content = await renderMdx(r.body, mdxCtx);
  const hasGraph = /<(Neighborhood|FlowMap)\b/.test(r.body);
  let graph = '';
  if (!hasGraph && !['diagram', 'adr'].includes(r.type)) {
    if (r.type === 'flow') graph = await renderFlow(ctx.catalog, r, { url: ctx.urls.url });
    else {
      const data = egoGraph(ctx.catalog, r);
      if (data.nodes.length > 1) graph = await renderGraph(data, { url: ctx.urls.url, title: r.name, height: 420 });
    }
  }
  const versions = r.versions.length > 1 ? `<label class="dc-versions">Version <select class="dc-version-select" aria-label="Select version">${r.versions.map((v) => `<option value="${h(ctx.urls.url(v, !v.isLatest))}"${v === r ? ' selected' : ''}>${h(v.version)}${v.isLatest ? ' (latest)' : ''}</option>`).join('')}</select></label>` : r.version ? `<span class="muted">v${h(r.version)}</span>` : '';
  const banners = [
    !r.isLatest ? `<aside class="dc-callout dc-callout-warning" role="note"><strong>Older version</strong><p>You are viewing v${h(r.version)}. <a href="${h(ctx.urls.url(r.versions.find((v) => v.isLatest)))}">Go to the latest version</a>.</p></aside>` : '',
    r.deprecated ? `<aside class="dc-callout dc-callout-danger" role="note"><strong>Deprecated${r.deprecated.date ? ` · ${h(new Date(r.deprecated.date).toISOString().slice(0, 10))}` : ''}</strong>${r.deprecated.message ? `<p>${h(r.deprecated.message)}</p>` : ''}</aside>` : '',
    r.draft ? `<aside class="dc-callout dc-callout-note" role="note"><strong>Draft</strong>${r.draft.message ? `<p>${h(r.draft.message)}</p>` : '<p>This resource is still being designed.</p>'}</aside>` : '',
  ].join('');
  const language = asArray(r.glossary);
  const body = `<nav class="dc-crumbs" aria-label="Breadcrumb"><a href="${ctx.urls.href(`browse/${TYPE_META[r.type].plural}/`)}">${h(TYPE_META[r.type].labelPlural)}</a> / <span>${h(r.name)}</span></nav>
    <header class="dc-head">${typeBadge(r.type)}<h1>${h(r.name)}</h1>${versions}</header>
    ${r.summary ? `<p class="dc-lead">${h(String(r.summary).trim())}</p>` : ''}
    <div class="dc-badges">${labels(r)}${r.status ? `<span class="dc-flag">${h(r.status)}</span>` : ''}</div>
    ${banners}
    ${graph}
    <article class="prose">${content}${r.type === 'flow' ? renderFlowSteps(ctx, r) : ''}${language.length ? `<h2>Glossary</h2>${language.map((t) => `<p><strong>${h(t.name)}</strong> — ${h(t.summary || t.description)}</p>`).join('')}` : ''}</article>`;
  // Flow pages give their width to the walkthrough, so they have no right panel.
  const isFlow = r.type === 'flow';
  const page = { title: r.name, description: r.summary, active: 'browse', wide: isFlow, body: isFlow ? `${body}${flowLinks(ctx, r)}` : body, rail: isFlow ? undefined : railFor(ctx, r) };
  emit(ctx, resourceBase(ctx, r, true), page);
  if (r.isLatest) emit(ctx, resourceBase(ctx, r), page);

  emitRaw(ctx, `${decodeURIComponent(resourceBase(ctx, r, true).slice(ctx.urls.base.length))}index.md`, fs.readFileSync(r.file, 'utf8'));

  const graphHtml = r.type === 'flow'
    ? await renderFlow(ctx.catalog, r, { url: ctx.urls.url, height: 560 })
    : await renderGraph(egoGraph(ctx.catalog, r), { url: ctx.urls.url, title: r.name, height: 720 });
  emit(ctx, ctx.urls.href(`maps/${TYPE_META[r.type].plural}/${seg(r.id)}/${seg(r.version ?? 'latest')}/`), {
    title: `${r.name} map`, active: 'maps', wide: true,
    body: `<nav class="dc-crumbs" aria-label="Breadcrumb"><a href="${ctx.urls.href('maps/')}">Maps</a> / <a href="${h(ctx.urls.url(r))}">${h(r.name)}</a></nav><h1>${h(r.name)}</h1>${graphHtml}`,
  });

  if (r.changelog) {
    const logBody = await renderMdx(r.changelog.body, mdxCtx);
    const schemaDiffs = renderSchemaHistory(ctx, r);
    emit(ctx, `${resourceBase(ctx, r, true)}changes/`, { title: `${r.name} changes`, active: 'browse', body: `<nav class="dc-crumbs" aria-label="Breadcrumb"><a href="${h(resourceBase(ctx, r, true))}">${h(r.name)}</a> / Changes</nav><h1>Changes</h1><article class="prose">${logBody}</article>${schemaDiffs}` });
  }
  for (const doc of r.docs) {
    const html = await renderMdx(doc.body, mdxCtx);
    emit(ctx, `${resourceBase(ctx, r, true)}pages/${doc.slug.split('/').map(seg).join('/')}/`, { title: doc.title || doc.slug, active: 'browse', body: `<nav class="dc-crumbs" aria-label="Breadcrumb"><a href="${h(resourceBase(ctx, r, true))}">${h(r.name)}</a> / ${h(doc.title || doc.slug)}</nav><h1>${h(doc.title || doc.slug)}</h1><article class="prose">${html}</article>` });
  }
  for (const spec of specsOf(r)) renderSpec(ctx, r, spec);
  for (const asset of r.assets) {
    const target = path.join(ctx.out, 'assets', TYPE_META[r.type].plural, String(r.id), String(r.version ?? 'latest'), asset);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(r.dir, asset), target);
  }
}

// Line diff between consecutive schema versions, shown on the changelog page.
function renderSchemaHistory(ctx, r) {
  const versions = r.versions.filter((v) => schemaFile(v));
  if (versions.length < 2) return '';
  const blocks = [];
  for (let i = 0; i < versions.length - 1; i += 1) {
    const read = (v) => fs.readFileSync(path.join(v.dir, schemaFile(v)), 'utf8').split('\n');
    const [next, prev] = [read(versions[i]), read(versions[i + 1])];
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    const lines = [...prev.filter((l) => !nextSet.has(l)).map((l) => `- ${l}`), ...next.filter((l) => !prevSet.has(l)).map((l) => `+ ${l}`)];
    if (lines.length) blocks.push(`<h3>v${h(versions[i + 1].version)} → v${h(versions[i].version)}</h3>${codeBlock(lines.join('\n'), 'diff')}`);
  }
  return blocks.length ? `<h2>Schema changes</h2>${blocks.join('')}` : '';
}

function renderSpec(ctx, r, spec) {
  const file = path.resolve(r.dir, String(spec.path));
  if (!file.startsWith(path.resolve(r.root)) || !fs.existsSync(file)) {
    ctx.catalog.warnings.push(`${r.id}: specification not found: ${spec.path}`);
    return;
  }
  const raw = fs.readFileSync(file, 'utf8');
  let doc = null;
  try {
    doc = /\.json$/i.test(file) ? JSON.parse(raw) : yaml.load(raw);
  } catch {
    doc = null;
  }
  let content = '';
  if (doc?.paths) {
    content = Object.entries(doc.paths).map(([route, ops]) => Object.entries(ops).filter(([m]) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m)).map(([method, op]) => `<details class="dc-op"><summary><span class="dc-method dc-method-${method}">${method.toUpperCase()}</span> <code>${h(route)}</code> <span class="muted">${h(op.summary || op.operationId || '')}</span></summary>${op.description ? `<p>${h(op.description)}</p>` : ''}${op.parameters?.length ? `<h4>Parameters</h4><ul>${op.parameters.map((p) => `<li><code>${h(p.name)}</code> <span class="muted">${h(p.in)}</span>${p.required ? ' <span class="dc-schema-req">required</span>' : ''} ${h(p.description)}</li>`).join('')}</ul>` : ''}<h4>Responses</h4><ul>${Object.entries(op.responses || {}).map(([code, res]) => `<li><code>${h(code)}</code> ${h(res?.description)}</li>`).join('')}</ul></details>`).join('')).join('');
  } else if (doc?.channels) {
    content = Object.entries(doc.channels).map(([name, channel]) => `<details class="dc-op" open><summary><code>${h(channel?.address || name)}</code></summary>${channel?.description ? `<p>${h(channel.description)}</p>` : ''}<ul>${['publish', 'subscribe'].filter((op) => channel?.[op]).map((op) => `<li><strong>${op}</strong>: ${h(channel[op].summary || channel[op].message?.name || channel[op].operationId || '')}</li>`).join('')}${Object.keys(channel?.messages || {}).map((m) => `<li>Message: <code>${h(m)}</code></li>`).join('')}</ul></details>`).join('');
  }
  emit(ctx, `${resourceBase(ctx, r, true)}specs/${seg(slugify(spec.path))}/`, {
    title: `${r.name} ${spec.type}`, active: 'browse',
    body: `<nav class="dc-crumbs" aria-label="Breadcrumb"><a href="${h(resourceBase(ctx, r, true))}">${h(r.name)}</a> / ${h(spec.name)}</nav><h1>${h(doc?.info?.title || spec.name)}</h1>${doc?.info?.version ? `<p class="muted">${h(spec.type)} · v${h(doc.info.version)}</p>` : ''}${doc?.info?.description ? `<p>${h(doc.info.description)}</p>` : ''}${content}<details ${content ? '' : 'open'}><summary>Raw specification</summary>${codeBlock(raw, /\.json$/i.test(file) ? 'json' : /\.g(raph)?ql$/i.test(file) ? 'graphql' : 'yaml')}</details>`,
  });
}

async function renderPeople(ctx) {
  const { catalog } = ctx;
  for (const type of ['team', 'user']) {
    const list = catalog.latest.filter((r) => r.type === type).sort((a, b) => a.name.localeCompare(b.name));
    const tabs = `<nav class="dc-tabs" aria-label="People"><a href="${ctx.urls.href('people/teams/')}"${type === 'team' ? ' aria-current="page"' : ''}>Teams</a><a href="${ctx.urls.href('people/users/')}"${type === 'user' ? ' aria-current="page"' : ''}>Users</a></nav>`;
    emit(ctx, ctx.urls.href(`people/${TYPE_META[type].plural}/`), {
      title: TYPE_META[type].labelPlural, active: 'people',
      body: `<h1>People</h1>${tabs}<div class="dc-cards" style="--cols:3">${list.map((r) => `<a class="dc-card" href="${h(ctx.urls.url(r))}"><strong>${h(r.name)}</strong><p>${h(r.summary || r.role || '')}</p><span class="muted">${(catalog.owned.get(r) || []).length} resources owned</span></a>`).join('') || '<p class="muted">None yet.</p>'}</div>`,
    });
    for (const r of list) {
      const owned = catalog.owned.get(r) || [];
      const members = asArray(r.members).map((m) => catalog.resolve('user', m)).filter(Boolean);
      const teams = type === 'user' ? catalog.latest.filter((t) => t.type === 'team' && asArray(t.members).some((m) => (m.id || m) === r.id)) : [];
      const contact = [r.email && `<a href="mailto:${h(r.email)}">${h(r.email)}</a>`, r.slackDirectMessageUrl && `<a href="${h(r.slackDirectMessageUrl)}" rel="noopener">Slack</a>`, r.msTeamsDirectMessageUrl && `<a href="${h(r.msTeamsDirectMessageUrl)}" rel="noopener">Teams</a>`].filter(Boolean).join(' · ');
      const html = await renderMdx(r.body, { catalog, resource: r, url: ctx.urls.url, href: ctx.urls.href, unknown: ctx.unknown });
      emit(ctx, ctx.urls.url(r), {
        title: r.name, active: 'people',
        body: `<nav class="dc-crumbs" aria-label="Breadcrumb"><a href="${ctx.urls.href(`people/${TYPE_META[type].plural}/`)}">${h(TYPE_META[type].labelPlural)}</a> / ${h(r.name)}</nav><header class="dc-head">${typeBadge(type)}<h1>${h(r.name)}</h1></header>${r.summary ? `<p class="dc-lead">${h(r.summary)}</p>` : ''}${contact ? `<p>${contact}</p>` : ''}<article class="prose">${html}</article>`,
        rail: `${linkList(ctx, 'Members', members)}${linkList(ctx, 'Teams', teams)}${linkList(ctx, 'Owns', owned)}`,
      });
      emitRaw(ctx, `${decodeURIComponent(ctx.urls.url(r).slice(ctx.urls.base.length))}index.md`, fs.readFileSync(r.file, 'utf8'));
    }
  }
}

function renderHome(ctx) {
  const { catalog, config, urls } = ctx;
  const custom = catalog.pages.find((p) => p.slug === 'index');
  if (custom) return;
  const counts = DISCOVER_TYPES.map((type) => [type, catalog.latest.filter((r) => r.type === type).length]).filter(([, c]) => c);
  const domains = catalog.latest.filter((r) => r.type === 'domain' && !r.parents.some((p) => p.type === 'domain')).sort((a, b) => a.name.localeCompare(b.name));
  const unowned = catalog.latest.filter((r) => !['team', 'user', 'diagram'].includes(r.type) && !r.ownerRefs.length).length;
  emit(ctx, urls.href(''), {
    title: 'Home', active: 'home', wide: true,
    body: `<section class="dc-hero"><h1>${h(config.title)}</h1><p>${h(config.tagline)}</p><div class="dc-actions"><a class="dc-btn dc-btn-primary" href="${urls.href('overview/')}">Explore the overview</a><a class="dc-btn" href="${urls.href('maps/')}">Open the maps</a></div></section>
    <dl class="dc-stats">${counts.map(([type, count]) => `<a href="${urls.href(`browse/${TYPE_META[type].plural}/`)}"><dd>${count}</dd><dt>${h(TYPE_META[type].labelPlural)}</dt></a>`).join('')}</dl>
    ${domains.length ? `<h2>Domains</h2><div class="dc-cards" style="--cols:3">${domains.map((d) => `<a class="dc-card" href="${h(urls.url(d))}"><strong>${h(d.name)}</strong><p>${h(String(d.summary || '').trim())}</p><span class="muted">${descendants(d).filter((c) => c.type === 'service').length} services</span></a>`).join('')}</div>` : ''}
    ${unowned ? `<p class="muted">${unowned} resources have no owner yet.</p>` : ''}`,
  });
}

function tree(ctx, r, seen = new Set()) {
  if (seen.has(r)) return '';
  seen.add(r);
  const children = (r.children || []).filter((c) => c.isLatest && !['diagram', 'adr'].includes(c.type));
  const link = `<a href="${h(ctx.urls.url(r))}">${h(r.name)}</a> ${typeBadge(r.type)}`;
  if (!children.length) return `<li>${link}</li>`;
  return `<li><details ${r.type === 'domain' ? 'open' : ''}><summary>${link}</summary><ul>${children.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)).map((c) => tree(ctx, c, new Set(seen))).join('')}</ul></details></li>`;
}

function renderArchitecture(ctx) {
  const { catalog } = ctx;
  const roots = catalog.latest.filter((r) => r.type === 'domain' && !r.parents.some((p) => p.type === 'domain')).sort((a, b) => a.name.localeCompare(b.name));
  const placed = new Set(roots.flatMap((d) => descendants(d)));
  const loose = catalog.latest.filter((r) => !roots.includes(r) && !placed.has(r) && !['team', 'user', 'diagram', 'adr', 'domain'].includes(r.type) && !r.parents.length);
  emit(ctx, ctx.urls.href('overview/'), {
    title: 'Overview', active: 'overview',
    body: `<h1>Overview</h1><p class="dc-lead">Every domain, down to the systems and resources inside it.</p><ul class="dc-tree">${roots.map((d) => tree(ctx, d)).join('')}</ul>${loose.length ? `<h2>Outside any domain</h2><ul class="dc-tree">${loose.map((r) => tree(ctx, r)).join('')}</ul>` : ''}`,
  });
}

async function renderVisualisers(ctx) {
  const { catalog, urls } = ctx;
  emit(ctx, urls.href('maps/'), {
    title: 'Maps', active: 'maps',
    body: `<h1>Maps</h1><div class="dc-cards" style="--cols:2">
      <a class="dc-card" href="${urls.href('maps/domains/')}"><strong>Domain map</strong><p>Domains and the messages flowing between them.</p></a>
      <a class="dc-card" href="${urls.href('maps/all/')}"><strong>Full map</strong><p>Every service, message, channel, store and flow.</p></a></div>
      <h2>Flows</h2><ul class="dc-rail-list">${catalog.latest.filter((r) => r.type === 'flow').map((f) => `<li><a href="${urls.href(`maps/flows/${seg(f.id)}/${seg(f.version ?? 'latest')}/`)}">${h(f.name)}</a></li>`).join('')}</ul>`,
  });
  emit(ctx, urls.href('maps/domains/'), { title: 'Domain map', active: 'maps', wide: true, body: `<h1>Domain map</h1>${await renderGraph(contextMap(catalog), { url: urls.url, title: 'Domain map', height: 720 })}` });
  emit(ctx, urls.href('maps/all/'), { title: 'Full map', active: 'maps', wide: true, body: `<h1>Full map</h1>${await renderGraph(fullGraph(catalog), { url: urls.url, title: 'Full map', height: 760 })}` });
}

function allSchemas(catalog) {
  return catalog.resources.map((r) => ({ r, file: schemaFile(r) })).filter((s) => s.file && s.r.assets.includes(s.file));
}

function renderSchemas(ctx) {
  const { catalog, urls } = ctx;
  const schemas = allSchemas(catalog);
  emit(ctx, urls.href('schemas/'), {
    title: 'Schemas', active: 'schemas', wide: true,
    body: `<h1>Schemas</h1><div class="dc-filters"><input type="search" class="dc-table-filter" placeholder="Filter schemas…" aria-label="Filter schemas"/><span class="dc-count muted">${schemas.length} results</span></div>
    <div class="dc-table-wrap"><table class="dc-sortable"><thead><tr><th>Resource</th><th>Type</th><th>Version</th><th>Format</th><th>Producers</th><th>Consumers</th></tr></thead><tbody>${schemas.map(({ r, file }) => `<tr data-search="${h(`${r.name} ${r.id} ${file}`.toLowerCase())}"><td><a href="${urls.href(`schemas/${TYPE_META[r.type].plural}/${seg(r.id)}/${seg(r.version ?? 'latest')}/`)}"><strong>${h(r.name)}</strong></a></td><td>${typeBadge(r.type)}</td><td>${r.version ? `v${h(r.version)}` : ''}</td><td>${h(path.extname(file).slice(1))}</td><td>${producersOf(catalog, r).length}</td><td>${consumersOf(catalog, r).length}</td></tr>`).join('')}</tbody></table></div>`,
  });
  const apiIndex = [];
  for (const { r, file } of schemas) {
    const content = fs.readFileSync(path.join(r.dir, file), 'utf8');
    const page = urls.href(`schemas/${TYPE_META[r.type].plural}/${seg(r.id)}/${seg(r.version ?? 'latest')}/`);
    emit(ctx, page, {
      title: `${r.name} schema`, active: 'schemas',
      body: `<nav class="dc-crumbs" aria-label="Breadcrumb"><a href="${urls.href('schemas/')}">Schemas</a> / <a href="${h(urls.url(r, !r.isLatest))}">${h(r.name)}</a></nav><h1>${h(r.name)} <span class="muted">v${h(r.version)}</span></h1>${renderSchema(content, file, file, { assetUrl: (f) => assetUrl(ctx, r, f) })}`,
      rail: `${linkList(ctx, 'Producers', producersOf(catalog, r))}${linkList(ctx, 'Consumers', consumersOf(catalog, r))}`,
    });
    apiIndex.push({ type: r.type, id: r.id, version: r.version, latest: r.isLatest, file, url: assetUrl(ctx, r, file) });
  }
  emitRaw(ctx, 'schemas/index.json', JSON.stringify(apiIndex, null, 2));
}

async function renderCustomDocs(ctx) {
  const { catalog, urls } = ctx;
  const docs = catalog.customDocs.slice().sort((a, b) => (a.sidebar?.order ?? 999) - (b.sidebar?.order ?? 999) || a.slug.localeCompare(b.slug));
  if (!docs.length) return;
  const groups = new Map();
  for (const doc of docs) {
    const group = doc.slug.includes('/') ? doc.slug.split('/')[0] : 'General';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(doc);
  }
  const docUrl = (doc) => urls.href(`guides/${doc.slug.split('/').map(seg).join('/')}/`);
  const sidebar = (current) => [...groups].map(([group, list]) => `<section><h3>${h(group.replace(/[-_]/g, ' '))}</h3><ul class="dc-rail-list">${list.map((d) => `<li><a href="${h(docUrl(d))}"${d === current ? ' aria-current="page"' : ''}>${h(d.sidebar?.label || d.title || d.slug)}</a></li>`).join('')}</ul></section>`).join('');
  emit(ctx, urls.href('guides/'), { title: 'Guides', active: 'guides', body: '<h1>Guides</h1><p class="dc-lead">Guides and reference for this organisation.</p>', rail: sidebar() });
  for (const doc of docs) {
    const html = await renderMdx(doc.body, { catalog, url: urls.url, href: urls.href, unknown: ctx.unknown });
    emit(ctx, docUrl(doc), { title: doc.title || doc.slug, description: doc.summary, active: 'guides', body: `<h1>${h(doc.title || doc.slug)}</h1>${doc.summary ? `<p class="dc-lead">${h(doc.summary)}</p>` : ''}<article class="prose">${html}</article>`, rail: sidebar(doc) });
  }
}

async function renderCustomPages(ctx) {
  for (const page of ctx.catalog.pages) {
    const html = await renderMdx(page.body, { catalog: ctx.catalog, url: ctx.urls.url, href: ctx.urls.href, unknown: ctx.unknown });
    emit(ctx, ctx.urls.href(page.slug === 'index' ? '' : `${page.slug.split('/').map(seg).join('/')}/`), { title: page.title || page.slug, active: page.slug === 'index' ? 'home' : '', body: `${page.title ? `<h1>${h(page.title)}</h1>` : ''}<article class="prose">${html}</article>` });
  }
}

function renderMachineFiles(ctx) {
  const { catalog, config, urls } = ctx;
  const origin = String(config.siteUrl || '').replace(/\/$/, '');
  const absolute = (p) => `${origin}${p}`;
  const index = [];
  const resources = catalog.latest.filter((r) => r.type !== 'team' && r.type !== 'user');
  index.push(...catalog.latest.map((r) => ({ title: r.name, type: r.type, id: r.id, version: r.version, summary: String(r.summary || '').trim().slice(0, 240), url: urls.url(r), ownedBy: (r.ownerRefs || []).map((o) => o.id), text: `${r.body.slice(0, 1500)}`.replace(/[`#*<>{}|_-]+/g, ' ') })));
  index.push(...catalog.customDocs.map((d) => ({ title: d.title || d.slug, type: 'doc', id: d.slug, summary: d.summary || '', url: urls.href(`guides/${d.slug}/`), ownedBy: [], text: d.body.slice(0, 1500).replace(/[`#*<>{}|_-]+/g, ' ') })));
  emitRaw(ctx, 'search.json', JSON.stringify(index));
  emitRaw(ctx, 'catalog.json', JSON.stringify({
    title: config.title,
    resources: catalog.resources.map(({ body, file, dir, root, versions, children, parents, ownerRefs, changelog, docs, assets, mtime, ...rest }) => ({ ...rest, ownedBy: (ownerRefs || []).map((o) => o.id), parents: (parents || []).map(resourceKey), children: (children || []).map(resourceKey), versions: (versions || []).map((v) => v.version) })),
    edges: catalog.edges.map((e) => ({ from: resourceKey(e.from), to: resourceKey(e.to), label: e.label, kind: e.kind })),
  }, null, 2));

  if (config.llms?.enabled !== false) {
    const sections = DISCOVER_TYPES.map((type) => {
      const list = resources.filter((r) => r.type === type);
      if (!list.length) return '';
      return `## ${TYPE_META[type].labelPlural}\n\n${list.map((r) => `- [${r.name}](${absolute(`${resourceBase(ctx, r, true)}index.md`)}): ${String(r.summary || '').trim().replace(/\s+/g, ' ')}`).join('\n')}\n`;
    }).filter(Boolean);
    emitRaw(ctx, 'llms.txt', `# ${config.title}\n\n> ${config.tagline}\n\n${sections.join('\n')}`);
    emitRaw(ctx, 'llms-full.txt', [`# ${config.title}`, ...resources.map((r) => `\n---\n# ${r.name} (${r.type}${r.version ? ` v${r.version}` : ''})\n\n${String(r.summary || '').trim()}\n\n${r.body.trim()}`), ...catalog.customDocs.map((d) => `\n---\n# ${d.title || d.slug}\n\n${d.body.trim()}`)].join('\n'));
    const schemaLines = allSchemas(catalog).filter((s) => s.r.isLatest).map(({ r, file }) => `\n---\n# ${r.name} (${r.type} v${r.version}) ${file}\n\n${fs.readFileSync(path.join(r.dir, file), 'utf8').trim()}`);
    emitRaw(ctx, 'llms-schemas.txt', `# ${config.title} schemas\n${schemaLines.join('\n')}`);
  }

  if (config.feeds?.enabled !== false) {
    const limit = config.feeds?.limit || 15;
    for (const type of ['event', 'command', 'query', 'service', 'domain', 'flow']) {
      const list = catalog.latest.filter((r) => r.type === type).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
      if (!list.length) continue;
      const items = list.map((r) => `<item><title>${h(r.name)}</title><link>${h(absolute(urls.url(r)))}</link><guid isPermaLink="false">${h(resourceKey(r))}</guid><pubDate>${r.mtime.toUTCString()}</pubDate><description>${h(String(r.summary || '').trim())}</description></item>`).join('');
      emitRaw(ctx, `feeds/${TYPE_META[type].plural}/feed.xml`, `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${h(config.title)} ${h(TYPE_META[type].labelPlural)}</title><link>${h(absolute(urls.href('')))}</link><description>${h(config.tagline)}</description>${items}</channel></rss>`);
    }
  }

  // RFC 9727 API catalog: one linkset entry for each published specification.
  const linkset = catalog.latest.flatMap((r) => specsOf(r).map((spec) => ({ anchor: absolute(urls.url(r)), 'service-desc': [{ href: absolute(assetUrl(ctx, r, path.relative(r.dir, path.resolve(r.dir, String(spec.path))).split(path.sep).join('/'))), type: /\.json$/i.test(spec.path) ? 'application/json' : 'application/yaml' }] })));
  emitRaw(ctx, '.well-known/api-catalog', JSON.stringify({ linkset }, null, 2));
  emitRaw(ctx, 'sitemap.txt', catalog.latest.map((r) => absolute(urls.url(r))).join('\n'));
}

export async function buildSite(catalog, { dev = false } = {}) {
  const config = catalog.config;
  let out = path.resolve(catalog.root, config.outDir || 'dist');
  const relative = path.relative(catalog.root, out);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`outDir must be a folder inside the catalog: ${out}`);
  // Publish atomically, so a failed build keeps the last good site and dev never serves a half-built one.
  const finalOut = out;
  out = `${finalOut}.next-${process.pid}`;
  fse.emptyDirSync(out);
  const customCss = [path.join(catalog.root, 'catalog.css')].find((f) => fs.existsSync(f));
  const ctx = { catalog, config, out, urls: createUrls(config), dev, unknown: new Set(), hasCustomCss: Boolean(customCss) };

  try {
    fs.mkdirSync(path.join(out, '_dc'), { recursive: true });
    fs.copyFileSync(path.join(CLIENT_DIR, 'app.css'), path.join(out, '_dc/app.css'));
    fs.copyFileSync(path.join(CLIENT_DIR, 'app.js'), path.join(out, '_dc/app.js'));
    fs.copyFileSync(require.resolve('mermaid/dist/mermaid.min.js'), path.join(out, '_dc/mermaid.min.js'));
    if (customCss) fs.copyFileSync(customCss, path.join(out, '_dc/custom.css'));
    for (const source of catalog.sources) {
      const publicDir = path.join(source.path, 'public');
      if (fs.existsSync(publicDir)) fse.copySync(publicDir, out, { overwrite: true });
    }

    renderHome(ctx);
    renderArchitecture(ctx);
    renderDiscover(ctx);
    await renderVisualisers(ctx);
    renderSchemas(ctx);
    await renderCustomDocs(ctx);
    await renderCustomPages(ctx);
    await renderPeople(ctx);
    for (const r of catalog.resources) {
      if (r.type !== 'team' && r.type !== 'user') await renderResource(ctx, r);
    }
    renderMachineFiles(ctx);
  } catch (error) {
    fse.removeSync(out);
    throw error;
  }
  // Two renames leave almost no moment without a site; deleting the old one comes after.
  const previous = `${out}-old`;
  if (fs.existsSync(finalOut)) fs.renameSync(finalOut, previous);
  fs.renameSync(out, finalOut);
  fse.removeSync(previous);
  return { out: finalOut, unknownComponents: [...ctx.unknown], warnings: catalog.warnings };
}
