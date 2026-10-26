# site-kit

Public, secret-free tooling for [Guardhouse](https://useguardhouse.com) customer sites. Each site lives in its own private repo (`UseGuardhouse/<slug>`, staging: `UseGuardhouse/<slug>-stg`, generated from `UseGuardhouse/site-template`) and calls the reusable workflows here.

## Workflows

- `.github/workflows/build.yml` (`workflow_call`): builds the calling repo (`npm ci && npm run build`), then uploads `dist/` to the Guardhouse ingest API. Environment is production unless the calling repository name ends in `-stg`.
- `.github/workflows/edit.yml` (`workflow_call`, input `job_id`): chat-driven edits. Jobs: `edit` (Claude drafts the change), `push` (policy, lint, commit, push `change/<crId>`), `build` (nested `build.yml` on the pushed commit, uploaded as a preview) and `report-failure`. Called from a site repo's `guardhouse-edit.yml`, which the Guardhouse API dispatches (`workflow_dispatch`) with a `job_id`.

Scripts (all zero-dependency Node 24 ESM): `scripts/upload.mjs` is the upload client (check, PUT missing blobs, finalize); `scripts/job.mjs` is the edit-job client (`prepare`, `place`, `push`, `fail`); `scripts/policy.mjs` holds the pure change-set, policy and lint functions; `scripts/lib.mjs` holds the shared origins, OIDC and retrying client. `ci.yml` tests them (`node --test "scripts/*.test.mjs"`) and lints workflows with actionlint.

## Security model

- The `build` job runs the site repo's code with `contents: read` only. It has no OIDC token and no secrets.
- The `upload` job has `id-token: write` but never checks out the calling repo. It runs only this repo's `upload.mjs` (from `main`) on the downloaded `dist` artifact.
- API origins are hard-coded in `upload.mjs` (`https://useguardhouse.com`, `https://staging.useguardhouse.com`). The workflow passes only `--env production|staging`, never a URL.
- The OIDC token's audience is that origin. The server verifies the signature, the org id, the repository, the event, and that `job_workflow_ref` is this repo's `build.yml@refs/heads/main`.
- Production builds are accepted only for `push` to `main` where the uploaded commit equals the token's `sha`.
- Blobs are content-addressed (sha256); the server checks them on write.
- This repo holds no secrets and must never be given any.

### Security model for chat edits (`edit.yml`)

The customer's words are untrusted input to a model that can write files, so the design assumes Claude may be manipulated and limits what that can reach.

- **Claude's job is boxed in.** The `edit` job has `contents: read` and `id-token: write` (the latter only so the action can exchange the job's OIDC token for Anthropic workload identity; no API key exists). Claude gets `Read, Edit, Write, Glob, Grep` only: no Bash, WebFetch, WebSearch, Task or GitHub MCP tools. Permission rules deny reads of `/proc`, `/etc`, the runner's home dot-directories, `RUNNER_TEMP` and `.git`, and deny edits to `.github`, `.claude`, `CLAUDE.md`, `.mcp.json`, `package*.json`, `.npmrc`, `astro.config.*` and the like. Those rules are defence in depth: the real gate is the push job's policy.
- **The request is data.** The customer's messages are written to `.guardhouse/request.json` (never into the prompt). The prompt, written by Guardhouse, tells Claude to treat that file as a description of the change, not as instructions. Customer photos are placed only under `public/uploads/` (paths validated twice, symlinked parents refused).
- **No site-kit or repo code runs after Claude.** Site-kit is checked out first, its scripts are copied outside the workspace, and the checkout is removed before Claude starts. After Claude, only shell `printf`/`cp`/`tar`/`find` run, to save the structured result, Claude's execution file and a symlink-free copy of the workspace as artifacts.
- **Only artifacts flow onward.** The job bundle is uploaded as an artifact before Claude starts, so later jobs read an untampered copy. The `push` job downloads the bundle, the edited workspace and the result; it never executes anything from the workspace.
- **Policy and lint run in a Claude-free job.** `push` (`contents: write`, `id-token: write`) computes the change set between the checkout of the commit the edit started from and the edited workspace, then enforces the bundle's policy: every changed path must match `editablePaths` and not `blockedPaths`, nothing under `.git`, `.github`, `.claude`, `node_modules`, no symlinks or special files, no `..` or absolute paths, and the file-count, patch-size and image-size limits. A violation, a no-op, or `needs_human` is reported as `rejected` and nothing is pushed. Lint then reports (without failing) newly added `<script>`, inline event handlers, `javascript:` URLs, `set:html`, `<iframe>`, newly introduced external hosts outside the allow-list, and, in `.astro` frontmatter, `fetch(`, `process.`, `import.meta.env` and non-local imports. Only the specific changed paths are committed, as `Guardhouse <guardhouse-bot@users.noreply.github.com>`, and the branch is pushed with the job token (a normal push, or `--force-with-lease` against the starting commit when revising an existing draft branch).
- **A human sits between the draft and the customer.** The pushed branch is built by the normal `build.yml` (repo code without a token, then an upload job that never checks out the repo) and shows up as a preview that Curtis reviews in the admin screens, with the lint findings. The customer only sees it after an admin sends it.
- Residual risk: the `edit` job's environment can mint OIDC tokens while Claude runs. Claude has no tool that can read the environment (`/proc` is denied) or make network calls, and the Guardhouse API only accepts edit tokens for the run it dispatched.

## Calling it from a site repo

```yaml
# .github/workflows/guardhouse-build.yml
name: Guardhouse build
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write   # required: a called workflow cannot raise the caller's permissions
jobs:
  build:
    uses: UseGuardhouse/site-kit/.github/workflows/build.yml@main
```

Private repos can call this public workflow once the organization allows reusable workflows from public repositories.
