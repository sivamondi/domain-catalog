// Computes architecture graphs and lays them out server-side as interactive SVG.
import ELK from 'elkjs/lib/elk.bundled.js';
import { TYPE_META, descendants, isMessage, resourceKey } from './model.mjs';
import { escapeHtml as h } from './util.mjs';

const elk = new ELK();
const NODE_W = 210;
const NODE_H = 58;

function nodeFor(r) {
  return { key: resourceKey(r), id: r.id, name: r.name, type: r.type, version: r.version, resource: r };
}

// The neighbourhood shown for one resource.
export function egoGraph(catalog, r, { depth = 1 } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const visit = (node) => nodes.set(node, nodeFor(node));
  const addEdge = (edge) => {
    visit(edge.from);
    visit(edge.to);
    edges.set(`${resourceKey(edge.from)}|${resourceKey(edge.to)}|${edge.label}`, edge);
  };
  const neighbours = (node) => {
    for (const edge of catalog.outgoing.get(node) || []) addEdge(edge);
    for (const edge of catalog.incoming.get(node) || []) addEdge(edge);
  };

  visit(r);
  if (r.type === 'domain' || r.type === 'system') {
    for (const child of descendants(r)) {
      if (child.type === 'diagram' || child.type === 'adr') continue;
      visit(child);
      neighbours(child);
    }
  } else {
    let frontier = [r];
    for (let level = 0; level < depth; level += 1) {
      const next = [];
      for (const node of frontier) {
        for (const edge of [...(catalog.outgoing.get(node) || []), ...(catalog.incoming.get(node) || [])]) {
          addEdge(edge);
          next.push(edge.from === node ? edge.to : edge.from);
        }
      }
      frontier = next;
    }
    // A message's channel edges carry no service, so pull the services through.
    if (isMessage(r)) neighbours(r);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()].map(edgeFor), focus: resourceKey(r) };
}

const edgeFor = (edge) => ({ from: resourceKey(edge.from), to: resourceKey(edge.to), label: edge.label });

export function fullGraph(catalog) {
  const included = catalog.latest.filter((r) => !['team', 'user', 'diagram', 'adr', 'domain', 'system'].includes(r.type));
  const set = new Set(included);
  return {
    nodes: included.map(nodeFor),
    edges: catalog.edges.filter((e) => set.has(e.from) && set.has(e.to)).map(edgeFor),
  };
}

// Domains as nodes, joined when one's services consume messages another's publish.
export function contextMap(catalog) {
  const domains = catalog.latest.filter((r) => r.type === 'domain' && !r.parents.some((p) => p.type === 'domain'));
  const owner = new Map();
  for (const domain of domains) for (const child of descendants(domain)) if (!owner.has(child)) owner.set(child, domain);
  const counts = new Map();
  for (const edge of catalog.edges) {
    if (edge.label !== 'consumed by') continue;
    const message = edge.from;
    for (const publish of catalog.incoming.get(message) || []) {
      if (publish.label !== 'publishes') continue;
      const a = owner.get(publish.from);
      const b = owner.get(edge.to);
      if (a && b && a !== b) {
        const key = `${resourceKey(a)}|${resourceKey(b)}`;
        counts.set(key, { from: a, to: b, count: (counts.get(key)?.count || 0) + 1 });
      }
    }
  }
  return {
    nodes: domains.map(nodeFor),
    edges: [...counts.values()].map(({ from, to, count }) => ({ from: resourceKey(from), to: resourceKey(to), label: `${count} message${count === 1 ? '' : 's'}` })),
  };
}

export function flowGraph(catalog, flow) {
  const nodes = [];
  const edges = [];
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const key = (id) => `step:${id}`;
  const known = new Set(steps.map((s) => String(s.id)));
  for (const step of steps) {
    let type = 'external';
    let resource = null;
    if (step.message) resource = catalog.resolve('message', step.message);
    else if (step.service) resource = catalog.resolve('service', step.service);
    else if (step.agent) resource = catalog.resolve('agent', step.agent);
    else if (step.flow) resource = catalog.resolve('flow', step.flow);
    else if (step.datastore) resource = catalog.resolve('datastore', step.datastore);
    else if (step.actor) type = 'actor';
    if (resource) type = resource.type;
    nodes.push({ key: key(step.id), id: String(step.id), name: step.title || resource?.name || step.actor?.name || step.externalSystem?.name || String(step.id), type, version: resource?.version, resource });
    const nexts = Array.isArray(step.next) ? step.next : step.next ? [step.next] : [];
    for (const next of nexts) {
      const id = String(typeof next === 'object' ? next.id : next);
      if (known.has(id)) edges.push({ from: key(step.id), to: key(id), label: typeof next === 'object' ? next.label : undefined });
    }
  }
  return { nodes, edges };
}

export function entityGraph(catalog, entities) {
  const set = new Set(entities);
  const nodes = entities.map(nodeFor);
  const edges = catalog.edges.filter((e) => set.has(e.from) && set.has(e.to) && e.kind === 'entity').map(edgeFor);
  return { nodes, edges };
}

function edgePath(section) {
  const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Lays out the graph and returns the viewer markup; `url` builds a resource link.
export async function renderGraph(graph, { url, title, height = 520, direction = 'RIGHT' }) {
  if (!graph.nodes.length) return '<p class="muted">Nothing to visualise yet.</p>';
  const ids = new Map(graph.nodes.map((n, i) => [n.key, `n${i}`]));
  const links = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const layout = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '28',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.separateConnectedComponents': 'true',
    },
    children: graph.nodes.map((n) => ({ id: ids.get(n.key), width: NODE_W, height: NODE_H })),
    edges: links.map((e, i) => ({ id: `e${i}`, sources: [ids.get(e.from)], targets: [ids.get(e.to)] })),
  });
  const positions = new Map(layout.children.map((c) => [c.id, c]));
  const used = new Set();
  const nodeSvg = graph.nodes.map((n) => {
    const pos = positions.get(ids.get(n.key));
    const meta = TYPE_META[n.type] || TYPE_META.external;
    used.add(n.type);
    const focus = n.key === graph.focus ? ' dc-node-focus' : '';
    const body = `<rect width="${NODE_W}" height="${NODE_H}" rx="9" class="dc-node-box" style="stroke:${meta.color}"/>`
      + `<rect width="7" height="${NODE_H}" rx="3.5" fill="${meta.color}"/>`
      + `<text x="18" y="24" class="dc-node-title">${h(truncate(n.name, 25))}</text>`
      + `<text x="18" y="43" class="dc-node-sub" fill="${meta.color}">${h(meta.label)}${n.version ? ` · v${h(n.version)}` : ''}</text>`;
    const target = n.resource && url(n.resource);
    const inner = target ? `<a href="${h(target)}">${body}</a>` : body;
    return `<g class="dc-node${focus}" data-name="${h(n.name.toLowerCase())}" data-node="${h(n.key)}" data-cx="${pos.x + NODE_W / 2}" data-cy="${pos.y + NODE_H / 2}" transform="translate(${pos.x} ${pos.y})"><title>${h(n.name)}</title>${inner}</g>`;
  }).join('');
  const edgeSvg = (layout.edges || []).map((edge, i) => {
    const section = edge.sections?.[0];
    if (!section) return '';
    const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
    const mid = points[Math.floor(points.length / 2)];
    const prev = points[Math.floor(points.length / 2) - 1] || mid;
    const label = links[i].label;
    return `<g class="dc-edge-group" data-from="${h(links[i].from)}" data-to="${h(links[i].to)}"><path d="${edgePath(section)}" class="dc-edge" marker-end="url(#dc-arrow)"/>`
      + (label ? `<text x="${((mid.x + prev.x) / 2).toFixed(1)}" y="${((mid.y + prev.y) / 2 - 5).toFixed(1)}" class="dc-edge-label" text-anchor="middle">${h(label)}</text>` : '')
      + '</g>';
  }).join('');
  const legend = [...used].map((type) => `<span class="dc-legend-item"><i style="background:${(TYPE_META[type] || TYPE_META.external).color}"></i>${h((TYPE_META[type] || TYPE_META.external).label)}</span>`).join('');
  const w = Math.ceil(layout.width);
  const hgt = Math.ceil(layout.height);
  return `<figure class="dc-graph" style="--dc-graph-h:${height}px" aria-label="${h(title || 'Architecture graph')}">
  <div class="dc-graph-toolbar">
    <input type="search" class="dc-graph-search" placeholder="Find node…" aria-label="Find a node in this graph"/>
    <button type="button" data-graph="in" aria-label="Zoom in">+</button><button type="button" data-graph="out" aria-label="Zoom out">−</button><button type="button" data-graph="fit">Fit</button><button type="button" data-graph="reset" hidden>Reset layout</button><button type="button" data-graph="full">Fullscreen</button><button type="button" data-graph="download">SVG</button>
  </div>
  <svg class="dc-graph-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hgt}" data-w="${w}" data-h="${hgt}" role="img">
    <defs><marker id="dc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dc-arrow"/></marker></defs>
    <g class="dc-graph-world">${edgeSvg}${nodeSvg}</g>
  </svg>
  <figcaption class="dc-legend">${legend}<span class="muted">${graph.nodes.length} nodes · ${links.length} links</span></figcaption>
</figure>`;
}
