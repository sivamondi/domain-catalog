// Imports OpenAPI, AsyncAPI and GraphQL files into catalog resources.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createSdk } from './sdk.mjs';
import { slugify } from './util.mjs';

const MESSAGE_TYPES = new Set(['event', 'command', 'query']);
const TYPE_EXTENSION = 'x-domaincatalog-kind';

const readSpec = (file) => {
  const raw = fs.readFileSync(file, 'utf8');
  return /\.json$/i.test(file) ? JSON.parse(raw) : yaml.load(raw);
};

// Inlines local `#/...` references, leaving cycles as plain references.
function deref(node, doc, stack = []) {
  if (Array.isArray(node)) return node.map((item) => deref(item, doc, stack));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (stack.includes(node.$ref)) return { $ref: node.$ref };
    const target = node.$ref.slice(2).split('/').reduce((acc, key) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return target === undefined ? node : deref(target, doc, [...stack, node.$ref]);
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, deref(value, doc, stack)]));
}

const stripPath = ({ path: _path, ...rest }) => rest;

function importService(sdk, service, messages, { domain, file, specType }) {
  const existing = sdk.get('service', service.id);
  if (domain && !sdk.get('domain', domain)) {
    sdk.write('domain', { id: domain, name: domain, version: '1.0.0', markdown: '## Overview\n\nCreated by the importer.\n' });
  }
  sdk.write('service', {
    ...(existing ? stripPath(existing) : {}),
    ...service,
    markdown: existing?.markdown || service.markdown,
    specs: [{ type: specType, path: path.basename(file), name: path.basename(file) }],
  }, { override: true, parent: domain ? { type: 'domain', id: domain } : undefined });
  if (domain) sdk.addToList('domain', domain, 'services', { id: service.id, version: service.version });
  sdk.addFile('service', service.id, { name: path.basename(file), content: fs.readFileSync(file, 'utf8') }, service.version);
  for (const { type, message, schema } of messages) {
    sdk.write(type, message, { override: true, parent: { type: 'service', id: service.id } });
    if (schema) sdk.addSchema(type, message.id, schema, { version: message.version });
  }
  return { service: service.id, version: service.version, messages: messages.length };
}

const contentSchema = (content) => {
  if (!content) return null;
  const media = content['application/json'] || Object.values(content)[0];
  return media?.schema || null;
};

const pickType = (value, fallback, label) => {
  const type = value || fallback;
  if (!MESSAGE_TYPES.has(type)) throw new Error(`${label}: unknown message type "${type}"`);
  return type;
};

export function generateOpenApi(root, file, { domain, service: serviceId } = {}) {
  const doc = readSpec(file);
  if (!doc?.paths) throw new Error(`${file} is not an OpenAPI document: no paths found`);
  const id = serviceId || slugify(doc.info?.title || path.basename(file));
  const version = String(doc.info?.version || '1.0.0');
  const messages = [];
  for (const [route, item] of Object.entries(doc.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = deref(item?.[method], doc);
      if (!op) continue;
      const messageId = op.operationId || slugify(`${method}-${route}`);
      messages.push({
        type: pickType(op[TYPE_EXTENSION], method === 'get' ? 'query' : 'command', messageId),
        schema: contentSchema(op.requestBody?.content) || contentSchema((op.responses?.['200'] || op.responses?.['201'])?.content),
        message: {
          id: messageId,
          name: op.summary || messageId,
          version,
          summary: op.description || op.summary || `${method.toUpperCase()} ${route}`,
          labels: [{ content: method.toUpperCase(), backgroundColor: 'blue', textColor: 'blue' }],
          markdown: `## Overview\n\n\`${method.toUpperCase()} ${route}\`\n\n${op.description || ''}\n\n<Neighborhood />\n`,
        },
      });
    }
  }
  return importService(createSdk(root), {
    id,
    name: doc.info?.title || id,
    version,
    summary: doc.info?.description?.split('\n')[0] || '',
    markdown: `## Overview\n\n${doc.info?.description || ''}\n\n<MessageList />\n\n<Neighborhood />\n`,
    consumes: messages.map(({ message }) => ({ id: message.id, version })),
    publishes: [],
  }, messages, { domain, file, specType: 'openapi' });
}

export function generateAsyncApi(root, file, { domain, service: serviceId } = {}) {
  const doc = readSpec(file);
  if (!doc?.channels) throw new Error(`${file} is not an AsyncAPI document: no channels found`);
  const id = serviceId || slugify(doc.info?.title || path.basename(file));
  const version = String(doc.info?.version || '1.0.0');
  const publishes = [];
  const consumes = [];
  const messages = new Map();
  const note = (raw, direction) => {
    const resolved = deref(raw, doc);
    const messageId = resolved?.messageId || resolved?.name || raw?.$ref?.split('/').pop();
    if (!messageId) return;
    messages.set(messageId, {
      type: pickType(resolved[TYPE_EXTENSION], 'event', messageId),
      schema: resolved.payload || null,
      message: { id: messageId, name: resolved.title || messageId, version, summary: resolved.summary || resolved.description || '', markdown: `## Overview\n\n${resolved.description || resolved.summary || ''}\n\n<Neighborhood />\n` },
    });
    (direction === 'send' ? publishes : consumes).push({ id: messageId, version });
  };
  if (doc.operations) {
    // AsyncAPI 3: operations carry the direction from the application's point of view.
    for (const op of Object.values(doc.operations)) {
      const channelName = op.channel?.$ref?.split('/').pop();
      for (const raw of op.messages || Object.values(doc.channels[channelName]?.messages || {})) note(raw, op.action === 'send' ? 'send' : 'receive');
    }
  } else {
    // AsyncAPI 2: `publish` means the application consumes, `subscribe` means it publishes.
    for (const channel of Object.values(doc.channels)) {
      for (const [opName, direction] of [['publish', 'receive'], ['subscribe', 'send']]) {
        const raw = channel?.[opName]?.message;
        if (raw) for (const single of raw.oneOf || [raw]) note(single, direction);
      }
    }
  }
  return importService(createSdk(root), {
    id,
    name: doc.info?.title || id,
    version,
    summary: doc.info?.description?.split('\n')[0] || '',
    markdown: `## Overview\n\n${doc.info?.description || ''}\n\n<MessageList />\n\n<Neighborhood />\n`,
    publishes,
    consumes,
  }, [...messages.values()], { domain, file, specType: 'asyncapi' });
}

export function generateGraphql(root, file, { domain, service: serviceId, version = '1.0.0' } = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const id = serviceId || slugify(path.basename(file).replace(/\.\w+$/, ''));
  const consumes = [];
  const publishes = [];
  const messages = [];
  for (const [typeName, type] of Object.entries({ Query: 'query', Mutation: 'command', Subscription: 'event' })) {
    const block = new RegExp(`type\\s+${typeName}\\s*\\{([\\s\\S]*?)\\n?\\}`).exec(raw)?.[1];
    if (!block) continue;
    for (const [, description, field, args, returns] of block.matchAll(/^\s*(?:"""([\s\S]*?)"""\s*)?(\w+)\s*(\([^)]*\))?\s*:\s*([^\n#]+)/gm)) {
      messages.push({ type, message: { id: field, name: field, version, summary: description?.trim() || `GraphQL ${typeName.toLowerCase()} returning ${returns.trim()}`, markdown: `## Overview\n\n\`\`\`graphql\n${field}${args || ''}: ${returns.trim()}\n\`\`\`\n\n<Neighborhood />\n` } });
      (type === 'event' ? publishes : consumes).push({ id: field, version });
    }
  }
  return importService(createSdk(root), { id, name: id, version, summary: 'GraphQL service', markdown: '## Overview\n\n<MessageList />\n\n<Neighborhood />\n', consumes, publishes }, messages, { domain, file, specType: 'graphql' });
}
