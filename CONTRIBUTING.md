# Contributing to the LightOn TypeScript SDK

Thank you so much for your interest in contributing to LightOn's TypeScript SDK! We welcome
contributions of all kinds. We do allow AI-generated contributions while these comply with our coding
rules within `AGENTS.md`, but WE DO require a human presence to answer the review.

## Checklist before submitting a PR

Here are a few requirements to ensure your contribution can be integrated swiftly:

- [ ] **Sign the Contributor License Agreement (CLA)**, [see details](#contributor-license-agreement-cla)
- [ ] **Keep scope isolated**, your changes should address 1 specific problem at a time
- [ ] **Ensure your PR passes all checks:**
  - [ ] Unit tests, `make test`
  - [ ] Type-level tests, `make test-types`
  - [ ] Linting and formatting, `make lint`
  - [ ] Type checking, `make type-check`
- [ ] **Add testing**, you should at least add 1 test

## Contributor License Agreement (CLA)

Before contributing code to the LightOn TypeScript SDK, you must sign our Contributor License
Agreement (CLA). This is a legal requirement for all contributions to be merged into the main
repository.

Important: we strongly recommend reviewing and signing the CLA before starting work on your
contribution, to avoid any delays in the PR process.

## Quickstart

### 1. Set up your local development environment

```bash
# Fork the repository on GitHub (click the Fork button at
# https://github.com/lightonai/lighton-typescript-sdk), then clone your fork locally
git clone https://github.com/YOUR_USERNAME/lighton-typescript-sdk.git

# Create a new branch for your feature (see "Commit and branch conventions" below)
git checkout -b feature/your-feature

# Install dependencies
pnpm install

# Install git hooks that enforce commit conventions (one-time, opt-in)
make install-hooks

# Verify your setup works
make test
```

You need Node 22 or newer and pnpm 10.16 or newer.

**Note: commit and branch conventions.** Commits follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) and branches follow
[Conventional Branches](https://conventionalbranch.org). Run `make install-hooks` once per clone to
enable the local git hooks that enforce these.

**Note: the supply-chain quarantine.** `pnpm-workspace.yaml` sets `minimumReleaseAge`, which ignores
any version published in the last three days so a freshly-compromised release is not picked up before
it is vetted. `pnpm install` will therefore resolve some dependencies one version behind `latest`,
and will tell you so. That is expected. A CI guard fails any PR that changes the setting.

### 2. Development flow

Here is the recommended workflow for making changes:

```bash
# Make your changes to the code
# ...

# Fix formatting and safe linting issues automatically
make lint-fix

# Run linting and format checks (matches CI exactly)
make lint

# Ensure type checking passes
make type-check

# Run the tests
make test
make test-types

# Commit your changes (must follow Conventional Commits, see above)
git add .
git commit -m "feat(scope): your descriptive commit message"

# Push and create a PR (branch must follow Conventional Branches, see above)
git push origin feature/your-feature
```

`make test` runs vitest, which strips types without checking them, so `make type-check` and
`make test-types` are separate gates. All four run in CI.

### 3. Regenerating the API types

`src/types/api.ts` is generated from the live OpenAPI schema and must never be edited by hand:

```bash
make gen-types
```

Commit the result alongside the change that needed it.

### 4. Testing the in-dev SDK

Inside the clone, the tests import the source tree directly, so your changes are live with no build
step. To exercise the packaged output instead:

```bash
make build
make check-package   # validates the exports map and the dual ESM/CJS types
```

To use your in-dev version **from another project**, link it. Edits in the clone take effect after a
`make build`:

```bash
cd /path/to/lighton-typescript-sdk
pnpm link --global

cd /path/to/your-project
pnpm link --global @lighton-ai/sdk
```

Or install straight from a branch, for reviewing someone else's PR or testing on a machine without
the clone:

```bash
pnpm add "github:lightonai/lighton-typescript-sdk#main"
pnpm add "github:THEIR_USERNAME/lighton-typescript-sdk#feature/their-feature"
```

Set `LIGHTON_API_KEY` in the consuming project's environment as usual, see the [README](README.md).

Undo a link with `pnpm unlink --global @lighton-ai/sdk`.

### 5. Running against the live API

`make e2e` smoke-tests the SDK against the real API. It creates a throwaway workspace, exercises
every verb and resource against the documents in `tests/e2e/`, and deletes what it made:

```bash
export LIGHTON_API_KEY="..."
make e2e
make e2e ARGS="--only search"
```

It is not part of `make test` and does not run in CI. Add a step there when you add a feature.

## Where to read next

Architecture and design decisions live in [AGENTS.md](AGENTS.md). Read it before changing
architecture, and keep it in sync per its maintenance rule.
