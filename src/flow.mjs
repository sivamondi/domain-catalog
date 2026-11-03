// Renders a flow as a map people can step through, with the data moving at each step.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { TYPE_META, consumersOf, isMessage, producersOf } from './model.mjs';
import { flowGraph, renderGraph } from './graph.mjs';
import { escapeHtml as h } from './util.mjs';

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const badge = (type) => {
  const meta = TYPE_META[type] || TYPE_META.external;
  return `<span class="dc-type" style="--c:${meta.color}">${h(meta.label)}</span>`;
};

function readFields(r) {
  const file = r.schema ? String(r.schema) : r.assets?.find((a) => /^schema\./i.test(a));
  if (!file) return [];
  const full = path.resolve(r.dir, file);
  if (!full.startsWith(`${path.resolve(r.root)}${path.sep}`) || !fs.existsSync(full)) return [];
  try {
    const text = fs.readFileSync(full, 'utf8');
    const schema = /\.ya?ml$/i.test(file) ? yaml.load(text) : JSON.parse(text);
    const required = schema?.required || [];
    return Object.entries(schema?.properties || {}).map(([name, property]) => ({ name, type: asArray(property?.type).join(' | ') || 'any', required: required.includes(name), description: property?.description }));
  } catch {
    return [];
  }
}

const peopleList = (title, list, url) => (list.length ? `<h4>${h(title)}</h4><ul class="dc-rail-list">${list.map((r) => `<li><a href="${h(url(r))}">${h(r.name)}</a> ${badge(r.type)}</li>`).join('')}</ul>` : '');

function stepPanel(catalog, step, node, url) {
  const r = node.resource;
  const summary = step.summary || r?.summary || step.actor?.summary || step.externalSystem?.summary;
  let details = '';
  if (r && isMessage(r)) {
    const fields = readFields(r);
    details += fields.length ? `<h4>Data in this message</h4><ul class="dc-flow-fields">${fields.map((f) => `<li><code>${h(f.name)}</code> <span class="dc-schema-type">${h(f.type)}</span>${f.required ? ' <span class="dc-schema-req">required</span>' : ''}${f.description ? `<div class="dc-schema-desc">${h(f.description)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No schema documented for this message.</p>';
    details += peopleList('Sent by', producersOf(catalog, r), url) + peopleList('Received by', consumersOf(catalog, r), url);
  } else if (r && (r.type === 'service' || r.type === 'agent')) {
    const incoming = (catalog.incoming.get(r) || []).filter((e) => e.label === 'consumed by').map((e) => e.from);
    const outgoing = (catalog.outgoing.get(r) || []).filter((e) => e.label === 'publishes').map((e) => e.to);
    details += peopleList('Receives', incoming, url) + peopleList('Publishes', outgoing, url);
  }
  return `<div class="dc-flow-step" data-step-panel="${h(step.id)}" hidden>
    <header class="dc-head">${badge(node.type)}<h3 tabindex="-1">${h(node.name)}</h3></header>
    ${summary ? `<p>${h(String(summary).trim())}</p>` : ''}
    ${details}
    ${r ? `<p><a href="${h(url(r))}">Open ${h(r.name)}</a></p>` : ''}
  </div>`;
}

// The first steps are those nothing points at, so a walkthrough begins at the real start of the flow.
function describeSteps(flow, graph) {
  const steps = asArray(flow.steps).filter((s) => s?.id !== undefined);
  const known = new Set(steps.map((s) => String(s.id)));
  const pointedAt = new Set();
  const plan = steps.map((step) => {
    const next = asArray(step.next).map((n) => ({ id: String(n?.id ?? n), label: n?.label || '' })).filter((n) => known.has(n.id));
    next.forEach((n) => pointedAt.add(n.id));
    return { id: String(step.id), title: graph.nodes.find((node) => node.id === String(step.id))?.name || String(step.id), next };
  });
  return { steps, plan, start: (plan.find((s) => !pointedAt.has(s.id)) || plan[0])?.id };
}

export async function renderFlow(catalog, flow, { url, height = 460, title, staticOnly = false }) {
  const graph = flowGraph(catalog, flow);
  const map = await renderGraph(graph, { url, title: title || flow.name, height });
  const { steps, plan, start } = describeSteps(flow, graph);
  if (staticOnly || !start) return map;
  const panels = steps.map((step) => stepPanel(catalog, step, graph.nodes.find((n) => n.id === String(step.id)), url)).join('');
  // Escaped as an attribute value, so catalog text can never become markup or script.
  return `<section class="dc-flow" data-flow-plan="${h(JSON.stringify(plan))}" data-flow-start="${h(start)}" aria-label="Step through ${h(flow.name)}" style="--dc-flow-h:${Number(height)}px">
    <div class="dc-flow-layout">
    ${map}
    <div class="dc-flow-panel">
      <div class="dc-flow-controls">
        <button type="button" class="dc-flow-back" disabled>Back</button>
        <span class="dc-flow-progress muted" role="status" aria-live="polite">${plan.length} steps</span>
        <button type="button" class="dc-flow-restart" hidden>Restart</button>
      </div>
      <div class="dc-flow-next"><button type="button" class="dc-btn dc-btn-primary" data-flow-go="${h(start)}">Start</button></div>
      <div class="dc-flow-intro"><p class="muted">Press Start to follow the data through this flow one step at a time.</p></div>
      ${panels}
    </div>
    </div>
  </section>`;
}
