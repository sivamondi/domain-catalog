// Regenerates examples/harbor, a sample catalog for a fictional coffee roaster.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdk } from '../src/sdk.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../examples/harbor');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const sdk = createSdk(root);

const file = (name, content) => {
  const full = path.join(root, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

file('domaincatalog.config.js', `export default {
  title: 'Harbor Coffee',
  tagline: 'How orders, payments and roasting fit together at Harbor Coffee.',
  outDir: 'dist',
  port: 3000,
  theme: 'harbor',
  logo: { text: 'Harbor Coffee' },
};
`);
file('.gitignore', 'dist\ndist.next*\n.domaincatalog\ncatalog.html\ncatalog.md\ncatalog.json\n');
file('gates.yaml', `gates:
  - id: no-breaking-schemas
    when: schema_breaking
    severity: error
    message: Breaking schema change
  - id: announce-new-consumers
    when: consumer_added
    severity: warn
`);
file('rules/messages-have-owners.rule.mjs', `export default {
  id: 'messages-have-owners',
  title: 'Every message has an owner',
  check({ catalog }) {
    return ['event', 'command', 'query']
      .flatMap((type) => catalog.resources(type))
      .filter((message) => !message.ownerRefs.length)
      .map((message) => \`\${message.name} has no owner\`);
  },
};
`);
file('rules/one-writer-per-store.rule.mjs', `export default {
  id: 'one-writer-per-store',
  title: 'Each data store has one writer',
  severity: 'warn',
  check({ catalog }) {
    return catalog.resources('datastore')
      .map((store) => ({ store, writers: catalog.incoming(store).filter((edge) => edge.label === 'writes to') }))
      .filter(({ writers }) => writers.length > 1)
      .map(({ store, writers }) => \`\${store.name} is written by \${writers.map((edge) => edge.from.name).join(', ')}\`);
  },
};
`);

sdk.write('user', { id: 'mira', name: 'Mira Okafor', role: 'Staff engineer', email: 'mira@harbor.example', markdown: 'Looks after ordering.' });
sdk.write('user', { id: 'tomas', name: 'Tomas Lind', role: 'Engineer', email: 'tomas@harbor.example', markdown: 'Looks after payments.' });
sdk.write('user', { id: 'priya', name: 'Priya Nair', role: 'Engineer', email: 'priya@harbor.example', markdown: 'Looks after roasting and shipping.' });
sdk.write('team', { id: 'ordering-team', name: 'Ordering', summary: 'Owns the shop and the order lifecycle.', members: ['mira'], markdown: 'The team behind the online shop.' });
sdk.write('team', { id: 'payments-team', name: 'Payments', summary: 'Owns taking and refunding payments.', members: ['tomas'], markdown: 'The team that keeps money moving.' });
sdk.write('team', { id: 'roastery-team', name: 'Roastery', summary: 'Owns roasting schedules and shipping.', members: ['priya'], markdown: 'The team closest to the beans.' });

const domain = (id, name, summary, owner, extra = '') => sdk.write('domain', {
  id, name, version: '1.0.0', summary, ownedBy: [owner],
  markdown: `## Overview\n\n${summary}\n\n${extra}\n\n## Architecture\n\n<Neighborhood />\n\n## Messages\n\n<MessageList />\n`,
});

domain('ordering', 'Ordering', 'Takes orders from the shop and follows them to the door.', 'ordering-team', `<Cards cols={2}>
  <Card title="The order journey" description="Follow one order end to end." href="/maps/flows/order-to-door/1.0.0/" />
  <Card title="Why an outbox?" description="Read the decision record." href="/catalog/adrs/adr-001-transactional-outbox/" />
</Cards>

:::tip Start here
The {{service:order-service}} is the best place to begin. It publishes {{event:order-placed}}.
:::`);
domain('payments', 'Payments', 'Charges customers and handles refunds.', 'payments-team', `\`\`\`mermaid
stateDiagram-v2
  [*] --> Requested
  Requested --> Captured: card accepted
  Requested --> Declined: card refused
  Captured --> Refunded: refund issued
\`\`\``);
domain('roastery', 'Roastery', 'Plans roasts and ships finished coffee.', 'roastery-team');

sdk.write('system', {
  id: 'shop-system', name: 'Shop System', version: '1.0.0', summary: 'Everything a customer touches when buying coffee.', ownedBy: ['ordering-team'],
  markdown: '## Overview\n\nThe storefront and the order service.\n\n<Neighborhood />\n',
}, { parent: { type: 'domain', id: 'ordering' } });
sdk.addToList('domain', 'ordering', 'systems', { id: 'shop-system' });

const service = (id, name, parent, summary, owner, publishes, consumes, extra = {}) => {
  sdk.write('service', {
    id, name, version: '1.0.0', summary, ownedBy: [owner], publishes: publishes.map((m) => ({ id: m })), consumes: consumes.map((m) => ({ id: m })), ...extra,
    markdown: `## Overview\n\n${summary}\n\n## Messages\n\n<MessageList />\n\n## Architecture\n\n<Neighborhood />\n`,
  }, { parent });
};

service('storefront', 'Storefront', { type: 'system', id: 'shop-system' }, 'The website customers order from.', 'ordering-team', ['place-order', 'get-order-status'], ['order-placed']);
service('order-service', 'Order Service', { type: 'system', id: 'shop-system' }, 'Accepts orders and owns their lifecycle.', 'ordering-team', ['order-placed', 'order-shipped-notice', 'take-payment'], ['place-order', 'get-order-status', 'payment-captured', 'parcel-shipped'], {
  writes: [{ id: 'orders-db' }], reads: [{ id: 'orders-db' }], entities: [{ id: 'order' }], repository: { url: 'https://git.harbor.example/shop/order-service', language: 'TypeScript' },
  specs: [{ type: 'openapi', path: 'openapi.yml', name: 'Order API' }],
});
service('payment-service', 'Payment Service', { type: 'domain', id: 'payments' }, 'Talks to the card provider and records outcomes.', 'payments-team', ['payment-captured', 'payment-declined'], ['take-payment'], { writes: [{ id: 'payments-db' }] });
service('roast-planner', 'Roast Planner', { type: 'domain', id: 'roastery' }, 'Turns orders into roasting schedules.', 'roastery-team', ['roast-scheduled'], ['order-placed'], { writes: [{ id: 'roast-db' }] });
service('shipping-service', 'Shipping Service', { type: 'domain', id: 'roastery' }, 'Books carriers and tracks parcels.', 'roastery-team', ['parcel-shipped'], ['roast-scheduled'], { reads: [{ id: 'roast-db' }] });
sdk.write('agent', {
  id: 'support-agent', name: 'Support Agent', version: '1.0.0', summary: 'Answers customer questions about their orders.', ownedBy: ['ordering-team'], publishes: [{ id: 'get-order-status' }], consumes: [{ id: 'order-shipped-notice' }],
  tools: [{ name: 'lookup_order', description: 'Finds an order by its number' }, { name: 'draft_reply', description: 'Prepares a reply for a person to approve' }],
  markdown: '## Overview\n\nHandles first-line support, and hands anything unusual to a person.\n\n<ToolList />\n\n<Neighborhood />\n',
}, { parent: { type: 'domain', id: 'ordering' } });
sdk.addToList('domain', 'ordering', 'agents', { id: 'support-agent' });
for (const [domainId, id] of [['payments', 'payment-service'], ['roastery', 'roast-planner'], ['roastery', 'shipping-service']]) sdk.addToList('domain', domainId, 'services', { id });
for (const id of ['storefront', 'order-service']) sdk.addToList('system', 'shop-system', 'services', { id });

sdk.addFile('service', 'order-service', { name: 'openapi.yml', content: `openapi: 3.0.3
info:
  title: Order API
  version: 1.0.0
  description: Places orders and reports their status.
paths:
  /orders:
    post:
      operationId: placeOrder
      summary: Place an order
      responses:
        '202':
          description: Order accepted
  /orders/{orderId}:
    get:
      operationId: getOrderStatus
      summary: Get an order's status
      parameters:
        - name: orderId
          in: path
          required: true
          description: The order number
          schema:
            type: string
      responses:
        '200':
          description: The order
        '404':
          description: No such order
` });

const message = (type, id, name, owner, parent, summary, properties, required, extra = {}) => {
  sdk.write(type, {
    id, name, version: '1.0.0', summary, ownedBy: [owner], ...extra,
    markdown: `## Overview\n\n${summary}\n\n## Schema\n\n<SchemaView file="schema.json" title="JSON Schema" />\n\n## Who uses it\n\n<Neighborhood />\n`,
  }, { parent: { type: 'service', id: parent } });
  sdk.addSchema(type, id, { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', description: summary, required, properties });
};

const orderId = { type: 'string', format: 'uuid', description: 'The order number' };
message('event', 'order-placed', 'Order Placed', 'ordering-team', 'order-service', 'Published when a customer places an order.', {
  orderId, total: { type: 'integer', description: 'Total in pence' }, currency: { type: 'string', enum: ['GBP', 'EUR'] }, items: { type: 'array', description: 'What was ordered', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, grams: { type: 'integer' } } } },
}, ['orderId', 'total', 'currency'], { labels: [{ content: 'Broker: Kafka', backgroundColor: 'blue', textColor: 'blue' }] });
message('event', 'order-shipped-notice', 'Order Shipped Notice', 'ordering-team', 'order-service', 'Tells customers their parcel is on its way.', { orderId, trackingUrl: { type: 'string', format: 'uri' } }, ['orderId']);
message('command', 'place-order', 'Place Order', 'ordering-team', 'order-service', 'Asks the Order Service to create an order.', { customerId: { type: 'string' }, basketId: { type: 'string' } }, ['customerId', 'basketId']);
message('query', 'get-order-status', 'Get Order Status', 'ordering-team', 'order-service', 'Returns where an order has got to.', { orderId }, ['orderId']);
message('command', 'take-payment', 'Take Payment', 'payments-team', 'payment-service', 'Asks for a card payment against an order.', { orderId, amount: { type: 'integer', description: 'Amount in pence' } }, ['orderId', 'amount']);
message('event', 'payment-captured', 'Payment Captured', 'payments-team', 'payment-service', 'The card provider accepted the payment.', { orderId, paymentId: { type: 'string' } }, ['orderId', 'paymentId']);
message('event', 'payment-declined', 'Payment Declined', 'payments-team', 'payment-service', 'The card provider refused the payment.', { orderId, reason: { type: 'string', enum: ['insufficient_funds', 'expired_card', 'other'] } }, ['orderId', 'reason'], { deprecated: { message: 'Moving to a single payment outcome event.' } });
message('event', 'roast-scheduled', 'Roast Scheduled', 'roastery-team', 'roast-planner', 'A batch containing this order has a roasting slot.', { batchId: { type: 'string' }, roastOn: { type: 'string', format: 'date' } }, ['batchId', 'roastOn']);
message('event', 'parcel-shipped', 'Parcel Shipped', 'roastery-team', 'shipping-service', 'A carrier collected the parcel.', { orderId, carrier: { type: 'string' } }, ['orderId']);

// Publish a newer Order Placed, so the sample shows versions, changelogs and schema changes.
sdk.write('event', {
  id: 'order-placed', name: 'Order Placed', version: '2.0.0', summary: 'Published when a customer places an order.', ownedBy: ['ordering-team'], labels: [{ content: 'Broker: Kafka', backgroundColor: 'blue', textColor: 'blue' }],
  markdown: '## Overview\n\nPublished when a customer places an order. Version 2 adds the customer id.\n\n## Schema\n\n<SchemaView file="schema.json" title="JSON Schema" />\n\n## Who uses it\n\n<Neighborhood />\n',
});
sdk.addSchema('event', 'order-placed', { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', description: 'Published when a customer places an order.', required: ['orderId', 'total', 'currency', 'customerId'], properties: { orderId, customerId: { type: 'string', description: 'Who placed the order' }, total: { type: 'integer', description: 'Total in pence' }, currency: { type: 'string', enum: ['GBP', 'EUR'] }, items: { type: 'array', description: 'What was ordered', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, grams: { type: 'integer' } } } } } });
sdk.writeChanges('event', 'order-placed', '## 2.0.0\n\nAdded `customerId` as a required field.\n\n## 1.0.0\n\nFirst version.');

const store = (id, name, parentId, summary, owner, type = 'database', technology = 'postgres@16') => sdk.write('datastore', { id, name, version: '1.0.0', summary, ownedBy: [owner], storeType: type, technology, markdown: `## Overview\n\n${summary}\n\n<Neighborhood />\n` }, { parent: { type: 'service', id: parentId } });
store('orders-db', 'Orders Database', 'order-service', 'The system of record for orders.', 'ordering-team');
store('payments-db', 'Payments Database', 'payment-service', 'Payment attempts and outcomes.', 'payments-team');
store('roast-db', 'Roast Schedule', 'roast-planner', 'Planned and finished roasting batches.', 'roastery-team');

sdk.write('entity', {
  id: 'order', name: 'Order', version: '1.0.0', summary: 'One purchase by one customer.', ownedBy: ['ordering-team'], identifier: 'orderId',
  properties: [{ name: 'orderId', type: 'UUID', required: true, description: 'The order number' }, { name: 'customerId', type: 'string', required: true, description: 'Who placed it', refersTo: 'customer' }, { name: 'status', type: 'string', required: true, description: 'Where it has got to' }],
  markdown: '## Overview\n\n<EntityFields />\n\n<EntityRelations id="ordering" />\n',
}, { parent: { type: 'domain', id: 'ordering' } });
sdk.write('entity', { id: 'customer', name: 'Customer', version: '1.0.0', summary: 'Someone who buys coffee.', ownedBy: ['ordering-team'], identifier: 'customerId', properties: [{ name: 'customerId', type: 'string', required: true, description: 'Unique customer id' }, { name: 'email', type: 'string', required: true, description: 'Where receipts go' }], markdown: '## Overview\n\n<EntityFields />\n' }, { parent: { type: 'domain', id: 'ordering' } });
for (const id of ['order', 'customer']) sdk.addToList('domain', 'ordering', 'entities', { id });

sdk.write('channel', { id: 'orders-topic', name: 'Orders Topic', version: '1.0.0', summary: 'Kafka topic for the order lifecycle.', ownedBy: ['ordering-team'], address: 'harbor.orders.{region}', protocols: ['kafka'], deliveryGuarantee: 'at-least-once', parameters: { region: { description: 'Which region the order belongs to', enum: ['uk', 'eu'], default: 'uk' } }, markdown: '## Overview\n\n<ChannelDetails />\n\n<Neighborhood />\n' });
sdk.addPublish('service', 'order-service', { id: 'order-placed', to: [{ id: 'orders-topic' }] });

sdk.write('dataset', { id: 'daily-sales', name: 'Daily Sales', version: '1.0.0', summary: 'Sales per day and per coffee, for planning.', ownedBy: ['roastery-team'], inputs: [{ id: 'order-placed' }], outputs: [{ id: 'roast-db' }], markdown: '## Overview\n\nA daily table the roastery plans from.\n\n<Neighborhood />\n' }, { parent: { type: 'domain', id: 'roastery' } });
sdk.write('adr', { id: 'adr-001-transactional-outbox', name: 'Publish events through an outbox', version: '1.0.0', summary: 'Events are written with the order and then relayed.', status: 'accepted', ownedBy: ['ordering-team'], concerns: [{ id: 'order-service', type: 'service' }], markdown: '## Context\n\nAn order must never be saved without its event being published.\n\n## Decision\n\nThe {{service:order-service}} writes events to an outbox table in the same transaction.\n\n## Consequences\n\nConsumers may see duplicates, so they must be idempotent.\n' });
sdk.write('diagram', { id: 'system-overview', name: 'System overview', version: '1.0.0', summary: 'The shop at a glance.', markdown: '```mermaid\nflowchart LR\n  Shop --> Orders --> Payments\n  Orders --> Roastery --> Shipping\n```\n' });

sdk.write('flow', {
  id: 'order-to-door', name: 'Order to Door', version: '1.0.0', summary: 'One order, from the website to the customer\'s door.', ownedBy: ['ordering-team'],
  steps: [
    { id: 'customer', title: 'Customer', actor: { name: 'Customer' }, next: { id: 'place', label: 'Checks out' } },
    { id: 'place', title: 'Place Order', message: { id: 'place-order' }, next: { id: 'orders', label: 'Sent to' } },
    { id: 'orders', title: 'Order Service', service: { id: 'order-service' }, next: { id: 'pay', label: 'Requests payment' } },
    { id: 'pay', title: 'Take Payment', message: { id: 'take-payment' }, next: [{ id: 'captured', label: 'Accepted' }, { id: 'declined', label: 'Refused' }] },
    { id: 'declined', title: 'Payment Declined', message: { id: 'payment-declined' } },
    { id: 'captured', title: 'Payment Captured', message: { id: 'payment-captured' }, next: { id: 'roast', label: 'Triggers' } },
    { id: 'roast', title: 'Roast Planner', service: { id: 'roast-planner' }, next: { id: 'ship', label: 'When roasted' } },
    { id: 'ship', title: 'Shipping Service', service: { id: 'shipping-service' }, next: { id: 'door', label: 'Delivers' } },
    { id: 'door', title: 'Delivered', actor: { name: 'Customer' } },
  ],
  markdown: '## Overview\n\nThe journey most orders take.\n\n<FlowMap />\n',
});
sdk.addToList('domain', 'ordering', 'flows', { id: 'order-to-door' });

sdk.writeGuide('guides/getting-started', { title: 'Getting started', summary: 'How this catalog is organised.', markdown: 'Start with the {{domain:ordering}} domain, then follow an order through the {{flow:order-to-door}} flow.\n' });
sdk.writeGuide('guides/naming-events', { title: 'Naming events', summary: 'Conventions for message names.', markdown: 'Name events in the past tense, such as {{event:order-placed}}.\n\n:::note\nCommands are imperative, such as {{command:place-order}}.\n:::\n' });
sdk.writePage('service', 'order-service', 'runbooks/stuck-orders', { title: 'Stuck orders', summary: 'What to do when orders stop moving.', markdown: 'Check the outbox relay first. See {{guide:guides/getting-started}} for background.\n' });

console.log(`Created ${path.relative(process.cwd(), root)}`);
