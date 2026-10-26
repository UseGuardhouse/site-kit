# site-kit

Public, secret-free tooling for [Guardhouse](https://useguardhouse.com) customer sites. Each site lives in its own private repo (`UseGuardhouse/<slug>`, staging: `UseGuardhouse/<slug>-stg`, generated from `UseGuardhouse/site-template`) and calls the reusable workflows here.

## Workflows

- `.github/workflows/build.yml` (`workflow_call`): builds the calling repo (`npm ci && npm run build`), then uploads `dist/` to the Guardhouse ingest API. Environment is production unless the calling repository name ends in `-stg`.
- `edit.yml`: **upcoming (Stage 2).** Chat-driven edits drafted with Claude. Not present yet.

`scripts/upload.mjs` is the zero-dependency upload client (check, PUT missing blobs, finalize). `ci.yml` tests it (`node --test scripts/`) and lints workflows with actionlint.

## Security model

- The `build` job runs the site repo's code with `contents: read` only. It has no OIDC token and no secrets.
- The `upload` job has `id-token: write` but never checks out the calling repo. It runs only this repo's `upload.mjs` (from `main`) on the downloaded `dist` artifact.
- API origins are hard-coded in `upload.mjs` (`https://useguardhouse.com`, `https://staging.useguardhouse.com`). The workflow passes only `--env production|staging`, never a URL.
- The OIDC token's audience is that origin. The server verifies the signature, the org id, the repository, the event, and that `job_workflow_ref` is this repo's `build.yml@refs/heads/main`.
- Production builds are accepted only for `push` to `main` where the uploaded commit equals the token's `sha`.
- Blobs are content-addressed (sha256); the server checks them on write.
- This repo holds no secrets and must never be given any.

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
