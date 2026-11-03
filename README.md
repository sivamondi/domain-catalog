# DomainCatalog

A docs-as-code architecture catalog. Describe domains, systems, services, messages, schemas, flows and owners in Markdown next to your code, and get a searchable static site, architecture maps, CI checks and an MCP server for AI agents.

New here? Follow [How to Build an Architecture Catalog](docs/building-a-catalog.md). See [FEATURES.md](FEATURES.md) for what is and isn't built, and [NOTICE.md](NOTICE.md) for third-party licenses.

## Quick start

Requires Node 22.23.4+ or 24.

```bash
npm install
```

Try the sample catalog at http://localhost:3000:

```bash
npm run dev:example
```

Create your own catalog:

```bash
node src/cli.mjs init ../my-catalog
```

```bash
node src/cli.mjs dev --dir ../my-catalog
```

## Commands

| Command | What it does |
| --- | --- |
| `init <dir>` | Create a starter catalog with a CI pipeline |
| `dev` | Build, serve on localhost, and rebuild on change |
| `build` | Build the static site into `outDir` |
| `serve` | Serve the built site. Set `DC_BASIC_AUTH=user:password` to require a login |
| `list [type]` | List resources |
| `add <type> --id <id>` | Create an event, command, query, service, domain or team |
| `generate openapi\|asyncapi\|graphql <file>` | Import a specification into services and messages |
| `export html\|markdown\|json` | Export the catalog as one file |
| `check` | Report broken references and unowned resources |
| `lint` | Validate frontmatter, references and attached files |
| `rules` | Run `*.rule.mjs` architecture rules |
| `breaking <old.json> <new.json>` | Compare two JSON Schemas |
| `snapshot create\|list\|diff` | Record and compare catalog states |
| `gate --base <snapshot>` | Apply `gates.yaml` to the changes since a snapshot |
| `mcp` | Run the stdio MCP server |

All catalog commands take `--dir <path>`, which defaults to the current folder. `check`, `lint`, `rules`, `breaking` and `gate` exit with 1 when they find a blocking problem, so they can run in CI. Add `--json` to `list`, `lint`, `rules`, `breaking`, `snapshot diff` and `gate` for machine-readable output.

## Catalog layout

```text
domaincatalog.config.js
gates.yaml
catalog.css
domains/Orders/resource.mdx
domains/Orders/services/OrderService/resource.mdx
domains/Orders/services/OrderService/pages/runbook.mdx
domains/Orders/services/OrderService/events/OrderPlaced/resource.mdx
domains/Orders/services/OrderService/events/OrderPlaced/changes.mdx
domains/Orders/services/OrderService/events/OrderPlaced/schema.json
domains/Orders/services/OrderService/events/OrderPlaced/history/0.9.0/resource.mdx
rules/messages-have-owners.rule.mjs
teams/platform.mdx
users/ada.mdx
guides/getting-started.mdx
site/index.mdx
public/
```

Resource folders are named `domains`, `systems`, `services`, `agents`, `events`, `commands`, `queries`, `channels`, `flows`, `entities`, `datastores`, `datasets`, `diagrams` and `adrs`.

## Resource frontmatter

```yaml
---
id: order-service
name: Order Service
version: 1.0.0
summary: Accepts orders and owns their lifecycle.
ownedBy:
  - ordering-team
publishes:
  - id: order-placed
    to:
      - id: orders-topic
consumes:
  - id: place-order
writes:
  - id: orders-db
reads:
  - id: orders-db
specs:
  - type: openapi
    path: openapi.yml
    name: Order API
labels:
  - content: Kafka
    backgroundColor: blue
---
```

Messages use `schema: schema.json`. Flow steps use `next`, as one pointer or a list. Data stores use `storeType`. Systems use `dependsOn`. Entity properties use `refersTo`. Decisions use `status` and `concerns`.

## Writing content

Link to anything with `{{type:id}}`, `{{type:id@1.0.0}}` or `{{type:id|Label}}`. Types also include `guide`, `spec` and `schema`.

| Component | What it shows |
| --- | --- |
| `<Neighborhood />` | This resource and what it connects to. Takes `id`, `type`, `depth` |
| `<FlowMap />`, `<EntityRelations />` | A flow, or how entities relate |
| `<SchemaView file="schema.json" />` | A schema as a tree, plus the raw file |
| `<MessageList />`, `<EntityFields />`, `<ChannelDetails />`, `<DecisionList />`, `<ToolList />` | Tables built from the catalog |
| `<Callout type="tip">`, `:::note` | Highlighted notes |
| `<Grid>` and `<Cell>`, `<Cards>` and `<Card>` | Layout |
| `<DisclosureGroup>` and `<Disclosure>`, `<Procedure>` and `<ProcedureStep>`, `<CodeTabs>`, `<PromptBlock>` | Content blocks |
| `<FieldList>` and `<Field>`, `<LinkList />` | Described fields, and a resource's attachments |
| `<Ref>`, `<PageLink>`, `<SpecLink>`, `<MermaidFile file="x.mmd" />`, `<Embed url="https://…" />` | Links and embeds |

Fenced `mermaid` blocks render as diagrams.

On any map, drag a box to move it, or focus it and press Shift + arrow keys. Connectors follow, a plain click still opens the box's page, and **Reset layout** undoes the moves. Positions are saved in each person's browser, not in the catalog, so they aren't shared and don't survive clearing site data.

Flow pages and `<FlowMap />` include a walkthrough: press Start, then Next or the right arrow key, to follow the flow. Where a step has several `next` targets, you choose the path. Each step shows what moves there, including a message's fields, senders and receivers. Exports show the map without the controls.

## Configuration

```js
export default {
  title: 'My Catalog',
  tagline: 'Discover, explore and document our architecture.',
  base: '/',
  outDir: 'dist',
  port: 3000,
  theme: 'iris', // iris, harbor, cobalt, ember or moss
  logo: { src: '/logo.png', text: 'My Catalog' },
  sourceUrl: 'https://git.example.com/catalog/edit/main',
  siteUrl: 'https://catalog.example.com', // makes llms.txt, feed and api-catalog links absolute
  nav: [{ label: 'Runbooks', href: 'guides/runbooks/' }],
  feeds: { enabled: true, limit: 15 },
  llms: { enabled: true },
  lint: { rules: { 'message-without-consumer': 'off', 'missing-owner': 'error' } },
  sources: [
    { path: '../team-payments', name: 'payments' },
    { git: 'https://git.example.com/team-orders-catalog', name: 'orders' },
  ],
};
```

Add `catalog.css` to override the theme's CSS variables.

## Site URLs

Pages use a side menu. The hamburger button collapses it to icons on desktop and opens it as a drawer on screens up to 900px wide. Items from the `nav` setting appear at the end of the menu.

| Path | Page |
| --- | --- |
| `/overview/` | Every domain and what's inside it |
| `/browse/<type>/` | Filterable tables |
| `/catalog/<type>/<id>/` | A resource. Older versions are at `/catalog/<type>/<id>/<version>/` |
| `/maps/`, `/maps/domains/`, `/maps/all/` | Architecture maps |
| `/schemas/` | Every schema |
| `/people/teams/`, `/people/users/` | Teams and users |
| `/guides/` | Guides |

## SDK

```js
import { createSdk } from 'domaincatalog/sdk';

const sdk = createSdk('./my-catalog');
sdk.write('service', { id: 'orders', name: 'Orders', version: '1.0.0', markdown: '## Overview' });
sdk.write('event', { id: 'order-placed', version: '1.0.0', summary: 'An order was placed.' }, { parent: { type: 'service', id: 'orders' } });
sdk.addSchema('event', 'order-placed', { type: 'object', properties: { orderId: { type: 'string' } } });
sdk.addPublish('service', 'orders', { id: 'order-placed' });

// A newer version moves the previous one into history/ automatically.
sdk.write('event', { id: 'order-placed', version: '2.0.0', summary: 'An order was placed.' });
sdk.versions('event', 'order-placed'); // ['2.0.0', '1.0.0']
```

Methods: `get`, `list`, `versions`, `locate`, `write`, `update`, `archive`, `remove`, `addFile`, `addSchema`, `addToList`, `addPublish`, `addConsume`, `addOwner`, `writeChanges`, `writeGuide`, `writePage`. Types: `domain`, `system`, `service`, `agent`, `event`, `command`, `query`, `channel`, `flow`, `entity`, `datastore`, `dataset`, `diagram`, `adr`, `team`, `user`.

## Architecture rules

Any `*.rule.mjs` file in the catalog is a rule. Return a list of violations; a rule that throws is reported as errored, never as passed.

```js
export default {
  id: 'messages-have-owners',
  title: 'Every message has an owner',
  severity: 'error', // or 'warn'
  check({ catalog }) {
    return catalog.resources('event')
      .filter((event) => !event.ownerRefs.length)
      .map((event) => `${event.name} has no owner`);
  },
};
```

## Gates

```yaml
gates:
  - id: no-breaking-schemas
    when: schema_breaking
    severity: error
    message: Breaking schema change
  - id: announce-new-consumers
    when: [consumer_added, consumer_removed]
    types: [event]
    severity: warn
```

Conditions: `resource_added`, `resource_removed`, `schema_changed`, `schema_breaking`, `owner_changed`, `deprecated`, `consumer_added`, `consumer_removed`, `producer_added`, `producer_removed`.

## Schema compatibility

`breaking` and `schema_breaking` use `consumer` mode by default. Use `--mode` to choose another.

| Mode | Question it answers | Breaking changes |
| --- | --- | --- |
| `consumer` | Can existing readers handle new data? | Property removed, no longer required, enum value added, type or format changed |
| `producer` | Can existing writers still produce valid data? | New required property, enum value removed, type or format changed |
| `full` | Both | Any of the above |

## CI and deployment

`init` adds `.github/workflows/catalog.yml`, `deploy.sh` and a `README.md` explaining their setup. On pull requests, the workflow runs `check`, `lint`, `rules`, `gate` and `build`. On `main`, it saves the built site as an artifact and runs `deploy.sh` once the `CATALOG_DEPLOY` variable is `true`.

The workflow fetches this tool from the Git repository named in the `DOMAINCATALOG_REPO` variable, so the tool must be in a repository CI can read. Existing catalogs can copy these files from `src/templates`.

## Connecting an AI agent

```bash
claude mcp add domaincatalog -- node /absolute/path/to/domaincatalog/src/cli.mjs mcp --dir /absolute/path/to/catalog
```

Tools: `list_resources`, `search`, `get_resource`, `get_relationships`, `get_schema`, `get_ownership`, `catalog_health`.

Every build also writes `llms.txt`, `llms-full.txt`, `llms-schemas.txt`, `catalog.json`, and a raw `index.md` for each resource.

## Security notes

- MDX is never executed. JSX tags map to a fixed set of built-in components, and `{frontmatter.x}` is a plain data lookup. Custom Astro or React components in a catalog render as their children only.
- Catalog Markdown can contain raw HTML, so only build catalogs from people you trust.
- `domaincatalog.config.js` and `*.rule.mjs` are JavaScript and do run on your machine.
- The SDK and importers refuse ids and file names that would write outside the catalog.
- The site can't change content. There is no in-app editor, and the server refuses everything except reads. To change the catalog, edit its files and deploy a new build.
- `dev` binds to 127.0.0.1.
- `DC_BASIC_AUTH` protects `serve` only. Use TLS in front of it, and put a real identity provider in front for production.

## Development

```bash
npm test
```

Regenerate the sample catalog in `examples/harbor`:

```bash
npm run example
```
