# Contributing

Thank you for helping make AI coding agent context (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, and MCP servers) observable, secure, and reproducible across **Claude Code**, **OpenAI Codex**, and **Cursor**.

## Fast-Track Contribution: Add a Stack Preset (5 minutes · Good First Issue)

The easiest way to make your first contribution to CtxWise is adding a curated stack preset in [`presets/`](presets/):

1. Create `presets/<stack-name>.yaml` (for example `presets/sveltekit.yaml`, `presets/django.yaml`, `presets/kotlin-spring.yaml`, `presets/terraform-aws.yaml`).
2. Follow the strict preset schema:
   ```yaml
   name: sveltekit
   stack: SvelteKit + TypeScript
   description: Lean startup token budget and Svelte 5 runes conventions for Claude Code and Codex.
   budget:
     maxKnownTokens: 3000
     maxContributorTokens: 1100
     unknown: warn
   recommendedMcpServers:
     - playwright
     - github
   rules:
     - "Use Svelte 5 runes (`$state`, `$derived`, `$props`) instead of legacy `export let` stores."
     - "Validate form actions and server load inputs on the server boundary."
     - "Run `npm run check` and `npm test` before completing a task."
   ```
3. Run `npm test` — `tests/unit/presets.test.ts` automatically validates every `.yaml` file in `presets/`!
4. Open a Pull Request referencing one of our open [`good first issue` tickets (`#23`–`#28`)](https://github.com/FramY2/ctxwise/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## Before opening a larger change

- Search existing issues and discussions.
- Open an issue first for new commands, new data collection, pricing semantics,
  or changes to lockfile/profile schemas.
- Keep changes local-first and avoid adding a model or hosted-service dependency.

## Development setup

```shell
npm ci
npm test
npm run typecheck
```

## Pull request requirements

1. Add or update a user journey and test before production behavior.
2. Preserve the RED/GREEN evidence for behavioral fixes.
3. Keep coverage at or above 80% for branches, functions, lines, and statements.
4. Update documentation and `CHANGELOG.md` when behavior changes.
5. Run:

```shell
npm run check
npm run build
npm run validate:plugin
npm pack --dry-run
```

## Invariants reviewers protect

- Subscription API-equivalent dollars are off by default and labelled not charged.
- Unknown measurements never become zero.
- CtxWise does not read session history by default.
- Secrets are redacted before lockfile hashing and inside `ctxwise shield` snippets.
- Profile installation creates a backup first.
- Child processes are invoked without a shell.

## Commit style

Use concise conventional prefixes such as `feat:`, `fix:`, `test:`, `docs:`,
and `refactor:`. One logical change per commit is preferred.

By contributing, you agree that your contribution is licensed under Apache-2.0.
