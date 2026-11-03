# Feature coverage

"Partial" means a working but smaller version; the limit is stated.

## Catalog model

| Feature | Status | Notes |
| --- | --- | --- |
| Domains, systems, services, agents | Built | Domains can nest |
| Events, commands, queries, channels | Built | |
| Flows, entities, data stores, datasets | Built | |
| Decision records, diagrams, teams, users | Built | |
| Versions and `history/` folders | Built | Semver ranges and `latest` resolve |
| Change notes | Built | |
| Resource pages and guides | Built | |
| Deprecated and draft states, labels | Built | |
| Glossary | Partial | Reads `glossary` frontmatter only |
| Described fields | Partial | `<FieldList>` markup only |

## Site

| Feature | Status | Notes |
| --- | --- | --- |
| Home page, or your own through `site/index.mdx` | Built | |
| Side menu with hamburger button | Built | Collapses to icons on desktop and remembers that choice per browser. Slides in as a drawer on phones |
| Browse tables with filter, owner filter and sort | Built | Columns are not configurable |
| Overview tree | Built | |
| Search | Built | Client-side index, covers the first 1,500 characters of each document |
| Schema pages and JSON/Avro/YAML viewer | Built | Other formats show as raw text |
| Schema version changes | Partial | Simple added/removed line diff on the changes page. Use `breaking` for semantic comparison |
| OpenAPI and AsyncAPI pages | Partial | Lists operations and channels, plus the raw spec; no request schemas or try-it |
| GraphQL spec pages | Partial | Raw text only |
| Team and user pages, ownership | Built | |
| `{{type:id}}` references, including guide, spec and schema | Partial | Hover details use a native browser tooltip |
| Themes, dark mode, custom CSS | Built | Five themes |
| Custom pages | Built | |
| Embed mode (`?embed=true`) | Built | |
| RSS feeds, `llms.txt`, `llms-full.txt`, `llms-schemas.txt` | Built | |
| RFC 9727 `.well-known/api-catalog` | Built | |
| Raw Markdown per resource | Built | |

## Maps

| Feature | Status | Notes |
| --- | --- | --- |
| Per-resource maps, full map, domain map | Built | Server-side layout rendered as SVG |
| Flow maps and steps | Built | |
| Step-through flow walkthrough | Built | Next, Back, Restart, arrow keys and branch choices. Shows each message's top-level fields, senders and receivers. Nested fields aren't listed; no autoplay or shareable step links |
| Pan, zoom, find, fullscreen, SVG export | Built | Zoom needs Ctrl/⌘ + scroll or the buttons |
| Movable boxes | Built | Saved per browser, not shared with others. Moved connectors use simple right-angle routes and can cross boxes |
| Entity relations | Built | |
| Mermaid diagrams | Built | Custom icon packs and layout options not wired |
| Minimap, grouping, notes | Not built | |
| Customisable nodes | Not built | |
| Comparing diagram versions | Not built | |

## Components

All components are listed in the [README](README.md#writing-content).

**Your own Astro or React components are not supported**, because MDX is deliberately not executed; they render as their children.

## Authoring and automation

| Feature | Status | Notes |
| --- | --- | --- |
| SDK | Built | 17 generic methods across all resource types |
| Scaffolding (`init`, `add`) | Built | |
| CI pipeline template | Partial | GitHub Actions only. Its commands are tested locally, but the workflow itself has not run on GitHub. You supply the deployment command |
| Dev server with live reload | Built | |
| In-app editing | Removed on purpose | Content changes only through catalog files and a new deployment |
| Linter | Built | 14 rules, configurable by severity. Checks structure and references; does not validate every frontmatter field against a schema |
| Architecture rules | Built | `.mjs` and `.js` only; TypeScript is not supported |
| Breaking-change detection | Partial | JSON Schema only; `$ref` targets are compared by name, not followed. No Avro or Protobuf |
| Snapshots and diffs | Built | |
| Gates | Partial | Blocks or warns in CI. No webhooks or notifications |
| Export | Partial | HTML, Markdown and JSON of the whole catalog. No selective exports |
| OpenAPI, AsyncAPI 2/3, GraphQL importers | Built | GraphQL uses a simple parser, not a full SDL parser |
| Combining several catalogs | Partial | Local paths work. Git sources are written but untested. First copy of a duplicate wins, with a warning |

## AI

| Feature | Status | Notes |
| --- | --- | --- |
| MCP server | Built | 7 read-only tools |
| LLM text exports | Built | |
| In-app AI assistant | Not built | |
| Slack bot and automated agents | Not built | |
| Installable AI skills | Not built | |

## Not built

| Feature | Notes |
| --- | --- |
| SSO and role-based access | `serve` has HTTP Basic only |
| Collaborative design canvas | |
| Importers for cloud schema registries and API gateways | Add through the SDK |
| Settings pages in the app | Configuration is by file |
| Custom API routes | Output is a static site |
| Configurable sidebars | |
| Hosted cloud service and billing | Out of scope |
