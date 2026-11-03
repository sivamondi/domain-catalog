import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildSite, checkGates, compareSchemas, createSdk, createSnapshot, diffSnapshots, generateAsyncApi, generateGraphql, generateOpenApi, lintCatalog, loadCatalog, loadConfig, renderMdx, runRules,
} from '../src/index.mjs';
import { exportHtml, exportJson, exportMarkdown } from '../src/export.mjs';
import { renderFlow } from '../src/flow.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { startServer } from '../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.mjs');
const EXAMPLE = path.join(here, '../examples/harbor');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
const cli = (...args) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8' });
const scratch = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const request = (port, target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  // Raw request: fetch would normalise ../ traversal away before it reached the server.
  const req = http.request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
  });
  req.on('error', reject);
  req.end(body);
});

let catalog;
before(async () => {
  catalog = loadCatalog(EXAMPLE, await loadConfig(EXAMPLE));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('loader finds every resource type in the sample', () => {
  const types = new Set(catalog.resources.map((r) => r.type));
  for (const type of ['domain', 'system', 'service', 'agent', 'event', 'command', 'query', 'channel', 'flow', 'entity', 'datastore', 'dataset', 'diagram', 'adr', 'team', 'user']) {
    assert.ok(types.has(type), `no ${type} in the sample`);
  }
  assert.deepEqual(catalog.broken, []);
  assert.deepEqual(catalog.warnings, []);
  assert.deepEqual(catalog.conflicts, []);
});

test('versions resolve, and the unversioned folder is the latest', () => {
  assert.equal(catalog.resolve('event', 'order-placed').version, '2.0.0');
  assert.equal(catalog.resolve('event', { id: 'order-placed', version: '1.0.0' }).version, '1.0.0');
  assert.equal(catalog.resolve('event', { id: 'order-placed', version: '1.x' }).version, '1.0.0');
  assert.equal(catalog.resolve('event', { id: 'order-placed', version: '9.0.0' }), null);
});

test('mdx renders components, leaves code alone, and never evaluates expressions', async () => {
  const ctx = { catalog, resource: { id: 'abc', name: 'A <b>', publishes: [1, 2] }, url: () => '#', href: (p) => p, unknown: new Set() };
  const html = await renderMdx([
    "import Thing from './thing.js';",
    '<Callout type="tip" title="Hi">**bold**</Callout>',
    '```js\nconst a = <Neighborhood />;\n```',
    '<Grid cols={2}><Cell>one</Cell><Cell>two</Cell></Grid>',
    '<Mystery onClick={globalThis.__pwned = true}>kept</Mystery>',
    '<Card href={`/x/${frontmatter.id}`} title={`Has ${frontmatter.publishes.length} publishes`} />',
    '{frontmatter.name} and {frontmatter.constructor.name}',
  ].join('\n\n'), ctx);
  assert.match(html, /dc-callout-tip/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /&lt;/, 'tag in a code fence stays literal');
  assert.match(html, /dc-columns/);
  assert.match(html, /kept/);
  assert.doesNotMatch(html, /import Thing/);
  assert.equal(globalThis.__pwned, undefined);
  assert.match(html, /href="\/x\/abc"/);
  assert.match(html, /Has 2 publishes/);
  assert.match(html, /A &lt;b&gt;/);
  assert.doesNotMatch(html, /Object|Function/, 'prototype fields never resolve');
  assert.ok(ctx.unknown.has('Mystery'));
});

test('flows render a walkthrough with safe data, the real start, branches and message fields', async () => {
  const flow = catalog.resolve('flow', 'order-to-door');
  const html = await renderFlow(catalog, flow, { url: (r) => `/r/${r.id}/` });
  const attribute = /data-flow-plan="([^"]+)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const plan = JSON.parse(attribute);
  assert.match(html, /data-flow-start="customer"/);
  assert.equal(plan.length, flow.steps.length);
  assert.deepEqual(plan.find((s) => s.id === 'pay').next.map((n) => n.id), ['captured', 'declined']);
  assert.deepEqual(plan.find((s) => s.id === 'door').next, []);
  assert.match(html, /data-step-panel="place"/);
  assert.match(html, /Data in this message/);
  assert.match(html, /Received by/);
  assert.match(html, /data-node="step:pay"/);
  assert.match(html, /data-cx="[\d.]+" data-cy="[\d.]+"/, 'boxes carry the positions dragging starts from');
  assert.match(html, /data-graph="reset" hidden>Reset layout/, 'reset stays hidden until something moves');
  assert.match(html, /data-from="step:pay" data-to="step:declined"/);
  assert.doesNotMatch(await renderFlow(catalog, flow, { url: () => '#', staticOnly: true }), /dc-flow-panel/, 'exports stay script-free');

  const hostile = { name: '<x>', steps: [{ id: 'a', title: '</button><script>alert(1)</script>', next: [{ id: 'b', label: '"><img src=x onerror=alert(1)>' }, { id: 'missing' }] }, { id: 'b', title: 'B', summary: '<script>bad()</script>' }] };
  const safe = await renderFlow(catalog, hostile, { url: () => '#' });
  assert.doesNotMatch(safe, /<script>|<img/, 'catalog text is always escaped');
  assert.match(safe, /data-flow-start="a"/);
  const looped = await renderFlow(catalog, { name: 'Loop', steps: [{ id: 'a', next: { id: 'b' } }, { id: 'b', next: { id: 'a' } }] }, { url: () => '#' });
  assert.match(looped, /data-flow-start="a"/, 'a flow with no clear start still has one');
  assert.doesNotMatch(await renderFlow(catalog, { name: 'Empty', steps: [] }, { url: () => '#' }), /dc-flow-panel/);
});

test('dev builds contain no way to edit files', async () => {
  const dir = scratch('no-editor');
  createSdk(dir).write('service', { id: 'a', version: '1.0.0', markdown: 'ok' });
  const site = await buildSite(loadCatalog(dir, {}), { dev: true });
  assert.doesNotMatch(fs.readFileSync(path.join(site.out, 'catalog/services/a/index.html'), 'utf8'), /__editor|Edit here/);
});

test('resource references become links and misses are reported', async () => {
  const warnings = catalog.warnings.length;
  const ctx = { catalog, url: (r) => `/r/${r.id}/`, href: (p) => `/${p}`, unknown: new Set() };
  const html = await renderMdx('See {{event:order-placed}}, {{entity:Nope}}, `{{event:in-code}}`.\n\n| a | b |\n|---|---|\n| {{service:order-service}} | x |\n', ctx);
  assert.match(html, /href="\/r\/order-placed\/"/);
  assert.match(html, /<td><a class="dc-ref"[^>]*>Order Service<\/a><\/td><td>x<\/td>/);
  assert.match(html, /<code>\{\{event:in-code\}\}<\/code>/);
  assert.equal(catalog.warnings.length, warnings + 1);
  catalog.warnings.length = warnings;
});

test('build emits pages and machine-readable outputs, with no dead internal links', async () => {
  const config = { ...(await loadConfig(EXAMPLE)), outDir: 'dist-test' };
  const site = await buildSite(loadCatalog(EXAMPLE, config));
  try {
    for (const file of ['index.html', 'llms.txt', 'llms-full.txt', 'llms-schemas.txt', 'search.json', 'catalog.json', '.well-known/api-catalog', 'feeds/events/feed.xml', 'browse/events/index.html', 'maps/all/index.html', 'maps/domains/index.html', 'schemas/index.html', 'people/teams/index.html', 'guides/index.html', 'overview/index.html', 'catalog/events/order-placed/1.0.0/index.html', 'catalog/events/order-placed/2.0.0/changes/index.html', 'catalog/services/order-service/1.0.0/specs/openapi-yml/index.html', 'catalog/services/order-service/1.0.0/pages/runbooks/stuck-orders/index.html']) {
      assert.ok(fs.existsSync(path.join(site.out, file)), `missing ${file}`);
    }
    assert.deepEqual(site.unknownComponents, []);
    const eventPage = fs.readFileSync(path.join(site.out, 'catalog/events/order-placed/index.html'), 'utf8');
    assert.match(eventPage, /class="dc-menu"[^>]*aria-controls="dc-sidebar"/, 'the menu button controls the sidebar');
    assert.match(eventPage, /id="dc-sidebar"/);
    assert.match(eventPage, /<a href="\/browse\/events\/" aria-current="true">/, 'the current type is highlighted on its resource pages');
    assert.match(fs.readFileSync(path.join(site.out, 'browse/events/index.html'), 'utf8'), /<a href="\/browse\/events\/" aria-current="page">/);
    assert.match(fs.readFileSync(path.join(site.out, 'catalog/domains/ordering/index.html'), 'utf8'), /<a href="\/catalog\/domains\/ordering\/" aria-current="page">Ordering/);
    assert.doesNotMatch(eventPage, /class="dc-nav"/, 'the top menu is gone');
    assert.match(eventPage, /class="dc-rail"/, 'other resource pages keep their right panel');
    assert.doesNotMatch(fs.readFileSync(path.join(site.out, 'catalog/flows/order-to-door/index.html'), 'utf8'), /class="dc-rail"/, 'flow pages have no right panel');
    assert.match(eventPage, /<h2><a href="\/browse\/domains\/">Domains<\/a><\/h2>/, 'the sidebar Domains heading is a link');
    assert.deepEqual(site.warnings, [], 'every reference in the sample resolves');
    assert.ok(JSON.parse(fs.readFileSync(path.join(site.out, '.well-known/api-catalog'), 'utf8')).linkset.length > 0);
    assert.match(fs.readFileSync(path.join(site.out, 'catalog/events/order-placed/2.0.0/changes/index.html'), 'utf8'), /Schema changes/);
    const missing = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.html')) {
          for (const match of fs.readFileSync(full, 'utf8').matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
            const target = path.join(site.out, decodeURIComponent(match[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&')));
            if (!fs.existsSync(target)) missing.add(`${path.relative(site.out, full)} -> ${match[1]}`);
          }
        }
      }
    };
    walk(site.out);
    assert.deepEqual([...missing].slice(0, 20), []);
  } finally {
    fs.rmSync(site.out, { recursive: true, force: true });
  }
});

test('build refuses an output folder outside the catalog', async () => {
  const unsafe = loadCatalog(EXAMPLE, { ...(await loadConfig(EXAMPLE)), outDir: '..' });
  await assert.rejects(buildSite(unsafe), /outDir must be a folder inside the catalog/);
});

test('a failed build keeps the last good site', async () => {
  const dir = scratch('atomic');
  const sdk = createSdk(dir);
  sdk.write('service', { id: 'a', version: '1.0.0', markdown: 'ok' });
  await buildSite(loadCatalog(dir, {}));
  assert.ok(fs.existsSync(path.join(dir, 'dist/catalog/services/a/index.html')));
  const bad = loadCatalog(dir, {});
  bad.resources[0].body = null;
  bad.latest[0].body = null;
  await assert.rejects(buildSite(bad));
  assert.ok(fs.existsSync(path.join(dir, 'dist/catalog/services/a/index.html')));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('dist.next')), []);
});

test('sdk writes, reads, versions and removes resources', () => {
  const dir = scratch('sdk');
  const sdk = createSdk(dir);
  sdk.write('domain', { id: 'shop', name: 'Shop', version: '1.0.0', markdown: 'Body' });
  sdk.write('service', { id: 'orders', version: '1.0.0', markdown: 'v1' }, { parent: { type: 'domain', id: 'shop' } });
  sdk.write('event', { id: 'placed', version: '1.0.0', summary: 'One', extra: undefined, markdown: 'first' }, { parent: { type: 'service', id: 'orders' } });
  assert.match(sdk.locate('event', 'placed'), /domains?|services\/orders\/events\/placed$/);
  assert.equal(sdk.get('event', 'placed').markdown, 'first');
  assert.throws(() => sdk.write('event', { id: 'placed', version: '1.0.0' }), /already exists/);

  sdk.addSchema('event', 'placed', { type: 'object' });
  assert.equal(sdk.get('event', 'placed').schema, 'schema.json');
  sdk.write('event', { id: 'placed', version: '2.0.0', markdown: 'second' });
  assert.deepEqual(sdk.versions('event', 'placed'), ['2.0.0', '1.0.0']);
  assert.equal(sdk.get('event', 'placed').markdown, 'second');
  assert.equal(sdk.get('event', 'placed', '1.0.0').markdown, 'first');
  assert.ok(fs.existsSync(path.join(sdk.locate('event', 'placed', '1.0.0'), 'schema.json')), 'schema moves with its version');
  assert.throws(() => sdk.write('event', { id: 'placed', version: '1.5.0' }), /older/);

  sdk.write('service', { id: 'orders', version: '2.0.0', markdown: 'v2' });
  assert.equal(sdk.get('event', 'placed').version, '2.0.0', 'archiving a service leaves nested resources in place');
  sdk.addPublish('service', 'orders', { id: 'placed' });
  sdk.addPublish('service', 'orders', { id: 'placed', version: '2.0.0' });
  assert.deepEqual(sdk.get('service', 'orders').publishes, [{ id: 'placed', version: '2.0.0' }]);

  assert.throws(() => sdk.remove('domain', 'shop'), /contains/);
  sdk.remove('event', 'placed');
  assert.equal(sdk.get('event', 'placed'), null);
  sdk.write('team', { id: 'crew', name: 'Crew' });
  assert.equal(sdk.get('team', 'crew').name, 'Crew');
  sdk.remove('team', 'crew');
  assert.equal(sdk.get('team', 'crew'), null);
});

test('sdk refuses ids and file names that would escape the catalog', () => {
  const dir = scratch('sdk-unsafe');
  const sdk = createSdk(dir);
  for (const id of ['../evil', 'a/b', '..', '']) assert.throws(() => sdk.write('event', { id, version: '1.0.0' }), /Invalid id/);
  sdk.write('event', { id: 'ok', version: '1.0.0' });
  assert.throws(() => sdk.addFile('event', 'ok', { name: '../../evil.txt', content: 'x' }), /Invalid file name/);
  assert.throws(() => sdk.writeGuide('../evil', { markdown: 'x' }), /Invalid file name/);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.txt')), false);
});

test('importers cannot be steered outside the catalog by a hostile spec', () => {
  const dir = scratch('hostile');
  const spec = path.join(tmp, 'hostile.yml');
  fs.writeFileSync(spec, "openapi: 3.0.0\ninfo: { title: Bad, version: 1.0.0 }\npaths:\n  /x:\n    get: { operationId: '../../../evil', responses: { '200': { description: ok } } }\n");
  assert.throws(() => generateOpenApi(dir, spec), /Invalid id/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'evil')), false);
});

test('OpenAPI import creates a service, messages and schemas, and re-import is idempotent', () => {
  const dir = scratch('openapi');
  const spec = path.join(tmp, 'pets.yml');
  fs.writeFileSync(spec, `openapi: 3.0.0
info: { title: Pet Store, version: 1.0.0, description: Pets. }
paths:
  /pets:
    get: { operationId: listPets, summary: List pets, responses: { '200': { description: ok } } }
    post:
      operationId: createPet
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
      responses: { '201': { description: created } }
  /pets/events:
    post: { operationId: petAdopted, x-domaincatalog-kind: event, responses: { '200': { description: ok } } }
components: { schemas: { Pet: { type: object, properties: { name: { type: string } } } } }
`);
  assert.deepEqual(generateOpenApi(dir, spec, { domain: 'animals' }), { service: 'pet-store', version: '1.0.0', messages: 3 });
  generateOpenApi(dir, spec, { domain: 'animals' });
  const loaded = loadCatalog(dir, {});
  assert.deepEqual(loaded.broken, []);
  assert.deepEqual(loaded.conflicts, []);
  assert.equal(loaded.latest.filter((r) => r.type === 'query').length, 1);
  assert.equal(loaded.latest.filter((r) => r.type === 'command').length, 1);
  assert.equal(loaded.latest.filter((r) => r.type === 'event').length, 1);
  const createPet = loaded.latest.find((r) => r.id === 'createPet');
  assert.equal(JSON.parse(fs.readFileSync(path.join(createPet.dir, 'schema.json'), 'utf8')).properties.name.type, 'string');
  assert.ok(loaded.latest.find((r) => r.id === 'pet-store').specs);

  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('version: 1.0.0', 'version: 2.0.0'));
  generateOpenApi(dir, spec, { domain: 'animals' });
  const upgraded = loadCatalog(dir, {});
  assert.deepEqual(upgraded.broken, []);
  assert.equal(upgraded.resolve('service', 'pet-store').version, '2.0.0');
  assert.equal(upgraded.resolve('query', 'listPets').version, '2.0.0');
  assert.ok(upgraded.resolve('service', { id: 'pet-store', version: '1.0.0' }), 'previous service version stays available');
  assert.ok(upgraded.resolve('query', { id: 'listPets', version: '1.0.0' }), 'previous message version stays available');
});

test('AsyncAPI 2 and 3 map direction from the application point of view', () => {
  const v2 = path.join(tmp, 'v2.yml');
  fs.writeFileSync(v2, `asyncapi: 2.6.0
info: { title: Billing, version: 1.0.0 }
channels:
  invoices:
    publish: { message: { name: pay-invoice, payload: { type: object } } }
    subscribe: { message: { name: invoice-paid } }
`);
  const dirA = scratch('async2');
  generateAsyncApi(dirA, v2);
  const service = loadCatalog(dirA, {}).resolve('service', 'billing');
  assert.deepEqual(service.consumes.map((p) => p.id), ['pay-invoice']);
  assert.deepEqual(service.publishes.map((p) => p.id), ['invoice-paid']);

  const v3 = path.join(tmp, 'v3.yml');
  fs.writeFileSync(v3, `asyncapi: 3.0.0
info: { title: Shipping, version: 1.0.0 }
channels:
  parcels: { address: parcels, messages: { parcelSent: { $ref: '#/components/messages/parcelSent' } } }
operations:
  sendParcel: { action: send, channel: { $ref: '#/channels/parcels' }, messages: [{ $ref: '#/channels/parcels/messages/parcelSent' }] }
components: { messages: { parcelSent: { name: parcel-sent, payload: { type: object } } } }
`);
  const dirB = scratch('async3');
  generateAsyncApi(dirB, v3);
  assert.deepEqual(loadCatalog(dirB, {}).resolve('service', 'shipping').publishes.map((p) => p.id), ['parcel-sent']);
});

test('GraphQL import maps queries, mutations and subscriptions', () => {
  const file = path.join(tmp, 'shop.graphql');
  fs.writeFileSync(file, 'type Query {\n  product(id: ID!): Product\n}\ntype Mutation {\n  buy(id: ID!): Boolean\n}\ntype Subscription {\n  sold: Product\n}\n');
  const dir = scratch('gql');
  assert.equal(generateGraphql(dir, file).messages, 3);
  const loaded = loadCatalog(dir, {});
  assert.equal(loaded.resolve('query', 'product').id, 'product');
  assert.equal(loaded.resolve('command', 'buy').id, 'buy');
  assert.equal(loaded.resolve('event', 'sold').id, 'sold');
});

test('linter reports each kind of problem, and rules can be configured', () => {
  assert.equal(lintCatalog(catalog).errors, 0, 'the sample has no lint errors');
  const dir = scratch('lint');
  const sdk = createSdk(dir);
  sdk.write('service', { id: 'svc', version: 'banana', ownedBy: ['ghost'], publishes: [{ id: 'nope' }], specs: [{ type: 'openapi', path: 'missing.yml' }], markdown: '' });
  sdk.write('event', { id: 'lonely', version: '1.0.0', schema: 'gone.json', markdown: '' });
  sdk.write('team', { id: 'crew', members: ['nobody'], markdown: '' });
  const load = (config = {}) => lintCatalog(loadCatalog(dir, config));
  const rules = new Set(load().findings.map((f) => f.rule));
  for (const rule of ['broken-reference', 'unknown-owner', 'unknown-member', 'missing-spec-file', 'missing-schema-file', 'invalid-version', 'missing-summary', 'missing-owner', 'message-without-producer', 'message-without-consumer']) {
    assert.ok(rules.has(rule), `expected ${rule}`);
  }
  assert.ok(load().errors > 0);
  const relaxed = load({ lint: { rules: { 'broken-reference': 'off', 'unknown-owner': 'warn' } } });
  assert.equal(relaxed.findings.some((f) => f.rule === 'broken-reference'), false);
  assert.equal(relaxed.findings.find((f) => f.rule === 'unknown-owner').severity, 'warn');
});

test('schema comparison classifies changes by who they break', () => {
  const before = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string', enum: ['x', 'y'] }, c: { type: 'integer' }, d: { type: 'object', properties: { e: { type: 'string' } } } } };
  const same = compareSchemas(before, before);
  assert.deepEqual([same.compatible, same.changes.length], [true, 0]);
  const kinds = (after, mode) => compareSchemas(before, after, { mode }).changes.filter((c) => c.breaking).map((c) => c.kind);
  const clone = () => structuredClone(before);

  const optionalAdded = clone();
  optionalAdded.properties.z = { type: 'string' };
  assert.deepEqual(kinds(optionalAdded, 'full'), []);

  const requiredAdded = clone();
  requiredAdded.properties.z = { type: 'string' };
  requiredAdded.required.push('z');
  assert.deepEqual(kinds(requiredAdded, 'consumer'), []);
  assert.deepEqual(kinds(requiredAdded, 'producer'), ['property-added']);

  const removed = clone();
  delete removed.properties.c;
  assert.deepEqual(kinds(removed, 'consumer'), ['property-removed']);
  assert.deepEqual(kinds(removed, 'producer'), []);

  const typed = clone();
  typed.properties.c.type = 'string';
  assert.deepEqual(kinds(typed, 'consumer'), ['type-changed']);
  assert.deepEqual(kinds(typed, 'producer'), ['type-changed']);

  const relaxed = clone();
  relaxed.required = [];
  assert.deepEqual(kinds(relaxed, 'consumer'), ['no-longer-required']);

  const enumAdded = clone();
  enumAdded.properties.b.enum.push('z');
  assert.deepEqual(kinds(enumAdded, 'consumer'), ['enum-value-added']);
  const enumRemoved = clone();
  enumRemoved.properties.b.enum.pop();
  assert.deepEqual(kinds(enumRemoved, 'producer'), ['enum-value-removed']);

  const nested = clone();
  delete nested.properties.d.properties.e;
  assert.equal(compareSchemas(before, nested).changes[0].path, '/d/e');
  assert.throws(() => compareSchemas({}, {}, { mode: 'nope' }), /Unknown compatibility mode/);
});

test('snapshots diff changes, and gates apply to them', () => {
  const dir = scratch('gates');
  const sdk = createSdk(dir);
  sdk.write('team', { id: 'a-team', markdown: '' });
  sdk.write('team', { id: 'b-team', markdown: '' });
  sdk.write('service', { id: 'producer', version: '1.0.0', ownedBy: ['a-team'], publishes: [{ id: 'evt' }], markdown: '' });
  sdk.write('service', { id: 'old', version: '1.0.0', markdown: '' });
  sdk.write('event', { id: 'evt', version: '1.0.0', markdown: '' });
  sdk.addSchema('event', 'evt', { type: 'object', properties: { a: { type: 'string' } } });
  const before = createSnapshot(loadCatalog(dir, {}));

  sdk.update('service', 'producer', { ownedBy: ['b-team'] });
  sdk.write('service', { id: 'consumer', version: '1.0.0', consumes: [{ id: 'evt' }], markdown: '' });
  sdk.remove('service', 'old');
  sdk.addSchema('event', 'evt', { type: 'object', properties: {} });
  const after = createSnapshot(loadCatalog(dir, {}));

  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added.map((r) => r.id), ['consumer']);
  assert.deepEqual(diff.removed.map((r) => r.id), ['old']);
  assert.ok(diff.changed.find((c) => c.id === 'producer').fields.includes('owners'));
  assert.equal(diff.changed.find((c) => c.id === 'evt').schemaChanges.compatible, false);
  assert.deepEqual(diffSnapshots(after, after), { added: [], removed: [], changed: [], edgesAdded: [], edgesRemoved: [] });

  const result = checkGates([
    { id: 'breaking', when: 'schema_breaking' },
    { id: 'owners', when: 'owner_changed', severity: 'warn' },
    { id: 'consumers', when: ['consumer_added'], severity: 'warn', message: 'New consumer' },
    { id: 'removals', when: 'resource_removed', types: ['service'] },
    { id: 'filtered', when: 'resource_removed', types: ['event'] },
  ], before, after);
  const fired = result.findings.map((f) => f.gate).sort();
  assert.deepEqual(fired, ['breaking', 'consumers', 'owners', 'removals']);
  assert.equal(result.errors, 2);
  assert.equal(result.warnings, 2);
  assert.match(result.findings.find((f) => f.gate === 'consumers').message, /New consumer: service consumer started consuming evt/);
});

test('rules pass, fail, warn, and never hide an error', async () => {
  const sample = await runRules(catalog);
  assert.deepEqual([sample.summary.total, sample.summary.failed, sample.summary.errored], [2, 0, 0]);

  const dir = scratch('rules');
  createSdk(dir).write('service', { id: 'svc', version: '1.0.0', markdown: '' });
  const rule = (name, body) => fs.writeFileSync(path.join(dir, `${name}.rule.mjs`), `export default ${body};`);
  rule('passes', "{ id: 'passes', check: () => [] }");
  rule('fails', "{ id: 'fails', check: ({ catalog }) => catalog.resources('service').map((s) => `${s.name} is bad`) }");
  rule('warns', "{ id: 'warns', severity: 'warn', check: () => 'just a note' }");
  rule('throws', "{ id: 'throws', check: () => { throw new Error('boom'); } }");
  rule('invalid', '{ nothing: true }');
  fs.writeFileSync(path.join(dir, 'broken.rule.mjs'), 'this is not javascript (');
  const report = await runRules(loadCatalog(dir, {}));
  assert.deepEqual(report.summary, { total: 6, passed: 1, warnings: 1, failed: 1, errored: 3 });
  assert.deepEqual(report.results.find((r) => r.id === 'fails').violations, [{ message: 'svc is bad' }]);
});

test('exports contain the catalog in each format', async () => {
  const html = await exportHtml(catalog);
  assert.match(html, /<h3>Order Placed<\/h3>/);
  assert.match(html, /id="event-order-placed"/);
  assert.doesNotMatch(html, /<script/, 'the export runs without scripts');
  assert.doesNotMatch(html, /href="\/(?!\/)/, 'the export has no site-relative links');
  assert.match(exportMarkdown(catalog), /### Order Placed \(v2\.0\.0\)/);
  const json = JSON.parse(exportJson(catalog));
  assert.equal(json.resources.length, catalog.resources.length);
  assert.equal(json.relationships.length, catalog.edges.length);
});

test('CLI commands work end to end and set exit codes', () => {
  const dir = path.join(tmp, 'starter');
  assert.equal(cli('init', dir).status, 0);
  assert.notEqual(cli('init', dir).status, 0, 'init refuses a folder with files in it');
  const run = (...args) => {
    const result = cli(...args, '--dir', dir);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  run('check');
  run('lint');
  run('add', 'event', '--id', 'order-shipped', '--service', 'order-service', '--summary', 'Shipped');
  assert.match(run('list', 'event'), /order-shipped v1\.0\.0/);
  run('build');
  assert.ok(fs.existsSync(path.join(dir, 'dist/catalog/events/order-shipped/index.html')));
  assert.match(run('rules'), /0 rules/);
  assert.ok(fs.existsSync(path.join(dir, '.domaincatalog/rules/results.json')));
  run('export', 'html');
  assert.ok(fs.existsSync(path.join(dir, 'catalog.html')));

  const base = /Snapshot: (.+) \(/.exec(run('snapshot', 'create'))[1];
  assert.match(run('snapshot', 'list'), /\.snapshot\.json/);
  assert.match(run('gate', '--base', base), /0 errors, 0 warnings/);
  const schema = path.join(dir, 'domains/Orders/services/OrderService/events/OrderPlaced/schema.json');
  const parsed = JSON.parse(fs.readFileSync(schema, 'utf8'));
  const oldSchema = path.join(tmp, 'old.json');
  fs.writeFileSync(oldSchema, JSON.stringify(parsed));
  delete parsed.properties.total;
  fs.writeFileSync(schema, JSON.stringify(parsed));
  const gate = cli('gate', '--base', base, '--dir', dir);
  assert.equal(gate.status, 1, 'a breaking change fails the gate');
  assert.match(gate.stdout, /Breaking schema change/);
  const breaking = cli('breaking', oldSchema, schema);
  assert.equal(breaking.status, 1);
  assert.match(breaking.stdout, /BREAKING \/total/);

  fs.writeFileSync(path.join(dir, 'domains/Orders/resource.mdx'), '---\nid: orders\nversion: 1.0.0\nservices:\n  - id: ghost\n---\n');
  assert.equal(cli('check', '--dir', dir).status, 1);
  assert.equal(cli('lint', '--dir', dir).status, 1);
  assert.equal(cli('nonsense').status, 1);
  assert.match(cli('help').stdout, /domaincatalog <command>/);
});

test('init creates a pipeline that checks, gates, builds and only deploys when enabled', () => {
  const dir = path.join(tmp, 'pipeline');
  assert.equal(cli('init', dir).status, 0);
  const workflow = yaml.load(fs.readFileSync(path.join(dir, '.github/workflows/catalog.yml'), 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' }, 'the workflow token can only read');
  assert.deepEqual(workflow.on.push.branches, ['main']);
  const steps = workflow.jobs.check.steps;
  const runs = steps.map((step) => step.run || '').join('\n');
  for (const command of ['check --dir catalog', 'lint --dir catalog', 'rules --dir catalog', 'snapshot create --dir base', 'gate --dir catalog', 'build --dir catalog']) {
    assert.ok(runs.includes(command), `the workflow runs ${command}`);
  }
  for (const step of steps.filter((s) => String(s.uses).startsWith('actions/checkout'))) {
    assert.equal(step.with['persist-credentials'], false, 'credentials are not left for catalog code to read');
  }
  const artifact = steps.find((s) => String(s.uses).startsWith('actions/upload-artifact'));
  assert.equal(artifact.with['include-hidden-files'], true, 'the artifact keeps .well-known');
  assert.equal(workflow.jobs.deploy.needs, 'check');
  assert.match(workflow.jobs.deploy.if, /CATALOG_DEPLOY == 'true'/, 'deployment is off until enabled');
  assert.ok(fs.statSync(path.join(dir, 'deploy.sh')).mode & 0o100, 'deploy.sh is executable');
  const deploy = spawnSync('bash', [path.join(dir, 'deploy.sh'), 'site'], { encoding: 'utf8' });
  assert.equal(deploy.status, 1, 'an unconfigured deployment fails instead of appearing to succeed');
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  assert.equal(cli('check', '--dir', dir).status, 0, 'the extra files do not affect the catalog');
  assert.equal(cli('lint', '--dir', dir).status, 0);
});

test('server blocks traversal, supports auth, and can never change files', async () => {
  const root = scratch('server');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const secret = path.join(root, 'secret.mdx');
  fs.writeFileSync(secret, '---\nid: s\n---\nsecret\n');
  fs.writeFileSync(path.join(root, 'dist/index.html'), 'home');
  const started = await new Promise((resolve) => {
    const s = startServer({ out: path.join(root, 'dist'), port: 0, dev: true, onListening: (p) => resolve({ s, p }) });
  });
  const { s: site, p: port } = started;
  try {
    assert.equal((await request(port, '/')).text, 'home');
    assert.notEqual((await request(port, '/../secret.mdx')).text.includes('secret'), true);
    assert.notEqual((await request(port, '/%2e%2e/secret.mdx')).text.includes('secret'), true);
    assert.equal((await request(port, '/__editor/?file=secret.mdx')).status, 404, 'the editor is gone, even in dev');
    const first = await request(port, '/__reload');
    assert.equal(first.status, 200, 'the reload check answers at once instead of holding a connection open');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    assert.equal((await request(port, '/__reload')).text, first.text, 'the version is stable between builds');
    site.reload();
    assert.notEqual((await request(port, '/__reload')).text, first.text, 'a rebuild changes the version');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await request(port, '/__editor/save', { method, headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` }, body: JSON.stringify({ file: 'secret.mdx', content: 'changed' }) });
      assert.equal(response.status, 405, `${method} is refused`);
    }
    assert.match(fs.readFileSync(secret, 'utf8'), /secret/);
  } finally {
    await site.close();
  }
  const locked = await new Promise((resolve) => {
    const s = startServer({ out: path.join(root, 'dist'), port: 0, auth: { user: 'a', password: 'b' }, onListening: (p) => resolve({ s, p }) });
  });
  try {
    assert.equal((await request(locked.p, '/')).status, 401);
    assert.equal((await request(locked.p, '/__reload', { headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } })).status, 404, 'production has no reload route');
    assert.equal((await request(locked.p, '/', { headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } })).status, 200);
  } finally {
    await locked.s.close();
  }
});

test('MCP server answers over the protocol', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(EXAMPLE);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: result.isError ? null : JSON.parse(result.content[0].text) };
  };
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['catalog_health', 'get_ownership', 'get_relationships', 'get_resource', 'get_schema', 'list_resources', 'search']);
    assert.ok((await call('list_resources', { type: 'event' })).data.total >= 5);
    assert.ok((await call('search', { query: 'order placed' })).data.some((r) => r.id === 'order-placed'));
    assert.ok((await call('get_relationships', { id: 'order-placed' })).data.producers.length > 0);
    assert.ok((await call('get_schema', { id: 'order-placed' })).data.content.length > 10);
    assert.deepEqual((await call('catalog_health')).data.brokenReferences, []);
    assert.equal((await call('get_resource', { id: 'does-not-exist' })).result.isError, true);
  } finally {
    await client.close();
  }
});
