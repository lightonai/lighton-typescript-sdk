SCHEMA_URL = https://api.lighton.ai/docs/schema/
HEADER = // Generated from the LightOn OpenAPI schema. Do not edit by hand, run 'make gen-types'.

.PHONY: test
test:  ## Run the test suite
	pnpm vitest run

.PHONY: e2e
e2e:  ## Smoke-test the SDK against the live API (needs LIGHTON_API_KEY): make e2e ARGS="--only search"
	node tests/e2e/cli.ts $(ARGS)

.PHONY: install-hooks
install-hooks:  ## Install the git hooks
	pnpm simple-git-hooks

.PHONY: lint
lint:  ## Check formatting and lint rules
	pnpm biome check .

.PHONY: lint-fix
lint-fix:  ## Auto-fix lint issues and format
	pnpm biome check --write .

.PHONY: type-check
type-check:  ## Type-check with tsc
	pnpm tsc --noEmit

.PHONY: build
build:  ## Build the dual ESM+CJS bundle
	pnpm tsdown

.PHONY: check-package
check-package: build  ## Validate the published package shape (exports, dual ESM/CJS types)
	pnpm publint
	pnpm attw --pack .

.PHONY: release
release:  ## Cut a release: make release VERSION=0.2.0 [DESC="notes shown above the changelog"]
	@echo "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "VERSION must be semver, e.g. make release VERSION=0.2.0"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "working tree not clean, commit or stash first"; exit 1; }
	@[ "$$(git branch --show-current)" = "main" ] || { echo "release from main only"; exit 1; }
	@git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null && { echo "tag v$(VERSION) already exists"; exit 1; } || true
	pnpm version "$(VERSION)" --no-git-tag-version
	git add package.json
	git commit -m "chore(release): v$(VERSION)"
	@if [ -n "$(DESC)" ]; then git tag -a "v$(VERSION)" -m "$(DESC)"; else git tag "v$(VERSION)"; fi
	git push origin main "v$(VERSION)"

.PHONY: gen-types
gen-types:  ## Regenerate the API types from the LightOn OpenAPI schema
	mkdir -p src/types
	# Download first: --url leaves a trailing-slash mismatch in $$ref bases that breaks resolution.
	TMP=$$(mktemp -d) && \
	curl -fsSL $(SCHEMA_URL) -o $$TMP/schema.yaml && \
	pnpm openapi-typescript $$TMP/schema.yaml --output $$TMP/api.ts --root-types --alphabetize && \
	{ echo "$(HEADER)"; echo; cat $$TMP/api.ts; } > src/types/api.ts && \
	pnpm biome format --write src/types/api.ts >/dev/null 2>&1 || true; \
	rm -rf $$TMP
