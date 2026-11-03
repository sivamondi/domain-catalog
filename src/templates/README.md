# Architecture catalog

This repository documents our architecture, and DomainCatalog builds it into a site. To change the catalog, edit these files and open a pull request. The site itself can't be edited.

## Preview locally

```bash
node /path/to/domaincatalog/src/cli.mjs dev
```

## Add content

Import a specification:

```bash
node /path/to/domaincatalog/src/cli.mjs generate openapi ../my-service/openapi.yml --domain orders
```

Create a resource:

```bash
node /path/to/domaincatalog/src/cli.mjs add event --id order-shipped --service order-service
```

Then edit the `resource.mdx` files to add owners, data stores and the reasons behind decisions. Flows go in `flows/`, and guides go in `guides/`.

## What the pipeline does

`.github/workflows/catalog.yml` runs on every pull request and on pushes to `main`.

| When | What runs | What fails it |
| --- | --- | --- |
| Pull requests and `main` | `check`, `lint`, `rules`, `build` | Broken references, lint errors, failed rules, or a failed build |
| Pull requests only | `gate`, comparing with the target branch | Any error-level gate in `gates.yaml`, such as a breaking schema change |
| `main` only | Saves the built site as the `catalog-site` artifact | |
| `main`, once enabled | `deploy.sh` publishes the site | A failed deployment |

## Set up the pipeline

DomainCatalog must be in a Git repository the pipeline can read. In this repository's GitHub settings, add:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `DOMAINCATALOG_REPO` | The tool's repository, as `owner/name` |
| Variable | `DOMAINCATALOG_REF` | Optional: the branch or tag to use. Defaults to `main`. A tag keeps builds repeatable |
| Secret | `DOMAINCATALOG_TOKEN` | Needed if that repository is private: a token that can only read it |

Then make the checks required for merging under branch protection. Otherwise a failed check won't block the merge.

## Turn on deployment

1. Put your upload command in `deploy.sh`.
2. Add any credentials it needs as secrets, and pass them to the Deploy step in the workflow.
3. Set the variable `CATALOG_DEPLOY` to `true`.

Until then, each push to `main` still produces the `catalog-site` artifact, which you can download from the workflow run.

**Choosing a host:** the built site has no login. If this catalog is internal, host it behind your VPN or SSO proxy. Check who can read it before using a public service such as GitHub Pages.

## Things to know

- Pull requests run this repository's `domaincatalog.config.js` and `*.rule.mjs` files in CI, so only accept changes to them from people you trust.
- GitHub doesn't give secrets to pull requests from forks, so the tool can't be fetched for those if its repository is private.
