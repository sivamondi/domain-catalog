#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TYPE_META, loadCatalog } from './model.mjs';
import { buildSite } from './site.mjs';
import { startServer } from './server.mjs';
import { loadConfig, writeFile } from './util.mjs';
import { createSdk } from './sdk.mjs';
import { generateAsyncApi, generateGraphql, generateOpenApi } from './generators.mjs';
import { formatLint, lintCatalog } from './lint.mjs';
import { createSnapshot, diffSnapshots, formatDiff, listSnapshots, readSnapshot, writeSnapshot } from './snapshot.mjs';
import { checkGates, loadGates } from './gates.mjs';
import { formatRules, runRules, writeRulesReport } from './rules.mjs';
import { compareSchemas } from './breaking.mjs';
import { EXPORTERS } from './export.mjs';

const HELP = `domaincatalog <command> [options]

Site
  init <dir>                     Create a new catalog, with a CI pipeline
  dev                            Build, serve on localhost, and rebuild on change
  build                          Build the static site
  serve                          Serve the built site (set DC_BASIC_AUTH=user:password to require a login)

Content
  list [type]                    List resources
  add <type> --id <id> [--name <name>] [--version <v>] [--summary <text>] [--service <id>] [--domain <id>]
                                 Create an event, command, query, service, domain, or team
  generate openapi|asyncapi|graphql <file> [--domain <id>] [--service <id>]
                                 Import a specification
  export html|markdown|json [--output <file>]
                                 Export the catalog as one file

Checks
  check                          Report broken references and unowned resources
  lint [--json]                  Validate frontmatter, references and files
  rules [--json]                 Run *.rule.mjs architecture rules
  breaking <old.json> <new.json> [--mode consumer|producer|full] [--json]
                                 Compare two JSON Schemas
  snapshot create [--label <text>] | snapshot list | snapshot diff <a> <b> [--json]
                                 Record and compare catalog states
  gate --base <snapshot> [--head <snapshot>] [--json]
                                 Apply gates.yaml to the changes since a snapshot

Agents
  mcp                            Run the stdio MCP server

Common options
  --dir <path>                   Catalog folder (default: current folder)
  --port <n>                     Port for dev and serve
  --host <host>                  Bind address for serve (default: 127.0.0.1)
`;

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');
const TEMPLATES = { '.github/workflows/catalog.yml': 'catalog.yml', 'deploy.sh': 'deploy.sh', 'README.md': 'README.md' };

const STARTER = {
  'domaincatalog.config.js': `export default {
  title: 'My Catalog',
  tagline: 'Discover, explore and document our architecture.',
  outDir: 'dist',
  port: 3000,
  // iris, harbor, cobalt, ember or moss
  theme: 'iris',
};
`,
  'package.json': `${JSON.stringify({ private: true, type: 'module', scripts: { dev: 'domaincatalog dev', build: 'domaincatalog build' } }, null, 2)}\n`,
  '.gitignore': 'dist\ndist.next*\n.domaincatalog\nnode_modules\n',
  'teams/platform.mdx': '---\nid: platform\nname: Platform\nsummary: Owns the shared platform.\nmembers:\n  - ada\n---\n\nThe platform team.\n',
  'users/ada.mdx': '---\nid: ada\nname: Ada Lovelace\nrole: Engineer\n---\n\nEngineer on the platform team.\n',
  'domains/Orders/resource.mdx': '---\nid: orders\nname: Orders\nversion: 1.0.0\nsummary: Everything about taking and fulfilling orders.\nownedBy:\n  - platform\nservices:\n  - id: order-service\n---\n\n## Overview\n\nThe Orders domain.\n\n<Neighborhood />\n',
  'domains/Orders/services/OrderService/resource.mdx': '---\nid: order-service\nname: Order Service\nversion: 1.0.0\nsummary: Accepts orders and publishes their lifecycle.\nownedBy:\n  - platform\npublishes:\n  - id: order-placed\n---\n\n## Overview\n\n<MessageList />\n\n<Neighborhood />\n',
  'domains/Orders/services/OrderService/events/OrderPlaced/resource.mdx': '---\nid: order-placed\nname: Order Placed\nversion: 1.0.0\nsummary: Published when a customer places an order.\nschema: schema.json\nownedBy:\n  - platform\n---\n\n## Overview\n\n<SchemaView file="schema.json" />\n\n<Neighborhood />\n',
  'domains/Orders/services/OrderService/events/OrderPlaced/schema.json': `${JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', description: 'Unique order id' }, total: { type: 'number', description: 'Order total' } } }, null, 2)}\n`,
  'guides/getting-started.mdx': '---\ntitle: Getting started\nsummary: How this catalog is organised.\n---\n\nEdit files in this folder to add documentation.\n',
  'gates.yaml': 'gates:\n  - id: no-breaking-schemas\n    when: schema_breaking\n    severity: error\n    message: Breaking schema change\n  - id: announce-removals\n    when: resource_removed\n    severity: warn\n',
};

function options(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' },
      version: { type: 'string' }, summary: { type: 'string' }, service: { type: 'string' }, domain: { type: 'string' }, output: { type: 'string' },
      label: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, mode: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
}

const open = async (root) => loadCatalog(root, await loadConfig(root));
const print = (flags, value, text) => console.log(flags.json ? JSON.stringify(value, null, 2) : text);

async function build(root, { dev = false } = {}) {
  const started = Date.now();
  const config = await loadConfig(root);
  const catalog = loadCatalog(root, config);
  const result = await buildSite(catalog, { dev });
  const notes = [...result.warnings, ...catalog.broken.map((b) => `broken reference: ${b.from} -> ${b.type}:${b.pointer}`), ...catalog.conflicts.map((c) => `duplicate ${c.key}: kept ${c.kept}`)];
  for (const note of notes) console.warn(`warning: ${note}`);
  if (result.unknownComponents.length) console.warn(`warning: unknown components rendered as plain content: ${result.unknownComponents.join(', ')}`);
  console.log(`Built ${catalog.resources.length} resources to ${path.relative(process.cwd(), result.out) || result.out} in ${Date.now() - started} ms`);
  return { config, catalog, result };
}

async function cmdDev(root, flags) {
  let { config, result } = await build(root, { dev: true });
  const port = Number(flags.port || config.port || 3000);
  const site = startServer({ out: result.out, port, host: '127.0.0.1', base: config.base || '/', dev: true, onListening: (p) => console.log(`Dev server: http://localhost:${p}${config.base || '/'}`) });
  let timer = null;
  let building = false;
  let again = false;
  const outName = path.relative(root, result.out).split(path.sep)[0];
  const rebuild = async () => {
    if (building) {
      again = true;
      return;
    }
    building = true;
    try {
      ({ config, result } = await build(root, { dev: true }));
      site.reload();
    } catch (error) {
      console.error(`Build failed: ${error.message}`);
    }
    building = false;
    if (again) {
      again = false;
      rebuild();
    }
  };
  fs.watch(root, { recursive: true }, (_event, file) => {
    const first = String(file || '').split(path.sep)[0];
    // Dot folders hold tool output , not catalog content.
    if (first === outName || first.startsWith(`${outName}.next`) || first === 'node_modules' || first.startsWith('.')) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  });
}

async function cmdServe(root, flags) {
  const config = await loadConfig(root);
  const out = path.resolve(root, config.outDir || 'dist');
  if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error('Nothing to serve yet. Run "domaincatalog build" first.');
  let auth;
  if (process.env.DC_BASIC_AUTH) {
    const at = process.env.DC_BASIC_AUTH.indexOf(':');
    if (at < 1) throw new Error('DC_BASIC_AUTH must look like user:password');
    auth = { user: process.env.DC_BASIC_AUTH.slice(0, at), password: process.env.DC_BASIC_AUTH.slice(at + 1) };
  }
  startServer({ out, port: Number(flags.port || config.port || 3000), host: flags.host || '127.0.0.1', base: config.base || '/', auth, onListening: (p) => console.log(`Serving ${out} on http://${flags.host || 'localhost'}:${p}${config.base || '/'}${auth ? ' (login required)' : ''}`) });
}

async function cmdCheck(root) {
  const catalog = await open(root);
  const unowned = catalog.latest.filter((r) => !['team', 'user', 'diagram'].includes(r.type) && !r.ownerRefs.length);
  const unresolvedOwners = catalog.latest.flatMap((r) => r.ownerRefs.filter((o) => o.unresolved).map((o) => `${r.type}:${r.id} -> ${o.id}`));
  console.log(`${catalog.resources.length} resources, ${catalog.edges.length} relationships`);
  for (const b of catalog.broken) console.log(`broken reference: ${b.from} -> ${b.type}:${b.pointer}${b.version ? `@${b.version}` : ''}`);
  for (const o of unresolvedOwners) console.log(`unknown owner: ${o}`);
  for (const w of catalog.warnings) console.log(`warning: ${w}`);
  for (const c of catalog.conflicts) console.log(`duplicate: ${c.key} (${c.dropped})`);
  console.log(`${catalog.broken.length} broken references, ${unresolvedOwners.length} unknown owners, ${unowned.length} unowned resources`);
  if (catalog.broken.length || catalog.conflicts.length) process.exitCode = 1;
}

function cmdAdd(root, type, flags) {
  if (!flags.id) throw new Error('--id is required');
  if (!['event', 'command', 'query', 'service', 'domain', 'team'].includes(type)) throw new Error('add supports: event, command, query, service, domain, team');
  const sdk = createSdk(root);
  const parent = flags.service ? { type: 'service', id: flags.service } : flags.domain && type === 'service' ? { type: 'domain', id: flags.domain } : undefined;
  if (type === 'team') sdk.write('team', { id: flags.id, name: flags.name || flags.id, summary: flags.summary || '', markdown: '' });
  else sdk.write(type, { id: flags.id, name: flags.name || flags.id, version: flags.version || '1.0.0', summary: flags.summary || '', markdown: '## Overview\n\n<Neighborhood />\n' }, { parent });
  console.log(`Created ${type} ${flags.id}`);
}

async function cmdList(root, type, flags) {
  if (type && !TYPE_META[type]) throw new Error(`Unknown type "${type}". Use one of: ${Object.keys(TYPE_META).join(', ')}`);
  const catalog = await open(root);
  const list = catalog.latest.filter((r) => !type || r.type === type).map((r) => ({ type: r.type, id: r.id, version: r.version, name: r.name }));
  print(flags, list, list.map((r) => `${r.type.padEnd(13)} ${r.id}${r.version ? ` v${r.version}` : ''}`).join('\n') || 'No resources');
}

async function cmdLint(root, flags) {
  const result = lintCatalog(await open(root));
  print(flags, result, formatLint(result));
  if (result.errors) process.exitCode = 1;
}

async function cmdRules(root, flags) {
  const report = await runRules(await open(root));
  const file = writeRulesReport(root, report);
  print(flags, report, `${formatRules(report)}\nReport: ${path.relative(process.cwd(), file)}`);
  if (report.summary.failed || report.summary.errored) process.exitCode = 1;
}

function cmdBreaking(positionals, flags) {
  if (positionals.length !== 2) throw new Error('Usage: breaking <old.json> <new.json>');
  const [before, after] = positionals.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
  const result = compareSchemas(before, after, { mode: flags.mode || 'consumer' });
  print(flags, result, [...result.changes.map((c) => `${c.breaking ? 'BREAKING' : 'ok      '} ${c.path}: ${c.message}`), result.compatible ? `Compatible (${result.mode})` : `Not compatible (${result.mode})`].join('\n'));
  if (!result.compatible) process.exitCode = 1;
}

async function cmdSnapshot(root, positionals, flags) {
  const [action, a, b] = positionals;
  if (action === 'create') {
    const snapshot = createSnapshot(await open(root), { label: flags.label });
    console.log(`Snapshot: ${writeSnapshot(root, snapshot)} (${snapshot.resources.length} resources)`);
  } else if (action === 'list') {
    console.log(listSnapshots(root).join('\n') || 'No snapshots');
  } else if (action === 'diff') {
    if (!a || !b) throw new Error('Usage: snapshot diff <a> <b>');
    const diff = diffSnapshots(readSnapshot(path.resolve(a)), readSnapshot(path.resolve(b)), { mode: flags.mode || 'consumer' });
    print(flags, diff, formatDiff(diff));
  } else {
    throw new Error('Usage: snapshot create | list | diff <a> <b>');
  }
}

async function cmdGate(root, flags) {
  if (!flags.base) throw new Error('--base <snapshot> is required');
  const before = readSnapshot(path.resolve(flags.base));
  const after = flags.head ? readSnapshot(path.resolve(flags.head)) : createSnapshot(await open(root));
  const result = checkGates(loadGates(root), before, after);
  print(flags, result, [...result.findings.map((f) => `${f.severity === 'error' ? 'error' : 'warn '} ${f.message} [${f.gate}]`), `${result.errors} errors, ${result.warnings} warnings`].join('\n'));
  if (result.errors) process.exitCode = 1;
}

async function cmdExport(root, format, flags) {
  const exporter = EXPORTERS[format];
  if (!exporter) throw new Error(`Usage: export ${Object.keys(EXPORTERS).join('|')} [--output <file>]`);
  const content = await exporter.run(await open(root));
  const output = path.resolve(flags.output || path.join(root, `catalog.${exporter.extension}`));
  writeFile(output, content);
  console.log(`Exported to ${output}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  const { values: flags, positionals } = options(rest);
  if (flags.help) {
    console.log(HELP);
    return;
  }
  const root = path.resolve(flags.dir || '.');
  switch (command) {
    case 'init': {
      const target = path.resolve(positionals[0] || flags.dir || '.');
      if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} is not empty`);
      for (const [file, content] of Object.entries(STARTER)) writeFile(path.join(target, file), content);
      for (const [file, template] of Object.entries(TEMPLATES)) writeFile(path.join(target, file), fs.readFileSync(path.join(TEMPLATE_DIR, template), 'utf8'));
      fs.chmodSync(path.join(target, 'deploy.sh'), 0o755);
      console.log(`Created a catalog in ${target}\nNext: domaincatalog dev --dir ${path.relative(process.cwd(), target) || '.'}`);
      break;
    }
    case 'build': await build(root); break;
    case 'dev': await cmdDev(root, flags); break;
    case 'serve': await cmdServe(root, flags); break;
    case 'check': await cmdCheck(root); break;
    case 'list': await cmdList(root, positionals[0], flags); break;
    case 'add': cmdAdd(root, positionals[0], flags); break;
    case 'lint': await cmdLint(root, flags); break;
    case 'rules': await cmdRules(root, flags); break;
    case 'breaking': cmdBreaking(positionals, flags); break;
    case 'snapshot': await cmdSnapshot(root, positionals, flags); break;
    case 'gate': await cmdGate(root, flags); break;
    case 'export': await cmdExport(root, positionals[0], flags); break;
    case 'generate': {
      const generate = { openapi: generateOpenApi, asyncapi: generateAsyncApi, graphql: generateGraphql }[positionals[0]];
      if (!generate || !positionals[1]) throw new Error('Usage: generate openapi|asyncapi|graphql <file>');
      const result = generate(root, path.resolve(positionals[1]), { domain: flags.domain, service: flags.service, version: flags.version });
      console.log(`Imported service ${result.service} v${result.version} with ${result.messages} messages`);
      break;
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.mjs');
      await runMcp(root);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Run "domaincatalog help".`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
