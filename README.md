# LightOn TypeScript SDK

TypeScript SDK for the LightOn API, the 🇪🇺 European industrial-grade retrieval
infrastructure powered by its frontier retrieval models developed in-house.

> **Status: under construction.** This is a port of the
> [LightOn Python SDK](https://github.com/lightonai/lighton-python-sdk) to TypeScript,
> aiming for feature parity. It is not published yet.

## Requirements

Node 22 or newer, or any runtime with global `fetch` and Web Streams (Bun, Deno,
Cloudflare Workers, Vercel Edge, the browser). The SDK has no runtime dependencies.

## Development

```sh
pnpm install
make install-hooks   # once per clone
make test
```

| Command | What it does |
| --- | --- |
| `make test` | Run the test suite |
| `make lint` | Check formatting and lint rules (matches CI) |
| `make lint-fix` | Auto-fix lint issues and format |
| `make type-check` | Type-check with `tsc` |
| `make build` | Build the dual ESM+CJS bundle |
| `make check-package` | Validate the published package shape |
| `make gen-types` | Regenerate `src/types/api.ts` from the LightOn OpenAPI schema |
| `make e2e` | Smoke-test against the live API (needs `LIGHTON_API_KEY`) |

`src/types/api.ts` is generated. Do not edit it by hand, run `make gen-types`.
