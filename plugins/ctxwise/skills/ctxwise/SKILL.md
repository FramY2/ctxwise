---
name: ctxwise
description: Audit and optimize OpenAI Codex context locally, compile model and subagent profiles, detect capability drift, create redacted lockfiles, inspect model-visible prompt structure, and render honest token, credit, quota, or API-cost receipts. Use when the user explicitly invokes CtxWise or asks to run its installed CLI for Codex context, usage, pricing, profile, drift, or reproducibility diagnostics.
---

# CtxWise

Use the installed `ctxwise` CLI. Keep diagnostics local and distinguish exact,
estimated, and unknown measurements.

## Workflow

1. Run `ctxwise doctor` when availability is uncertain.
2. Select the narrowest command:
   - `ctxwise snapshot` for an immediate ranked context health check and safe next actions.
   - `ctxwise audit --json` for config, guidance, skills, agents, and MCP inventory.
   - `ctxwise map --out ctxwise-context.mmd` for a local visual context map.
   - `ctxwise xray <prompt-input.json> --json` for a privacy-safe prompt breakdown.
   - `ctxwise profile <policy.yaml> --dry-run` before staging or installing profiles.
   - `ctxwise lock` for a redacted, hash-based reproducibility manifest.
   - `ctxwise drift --fail-on-drift` to detect unreviewed context changes locally or in CI.
   - `ctxwise quota --json` for the current local plan and rate-limit snapshot.
   - `ctxwise run --receipt --prompt-xray "<prompt>"` for a final-answer receipt
     with an estimated pre-turn prompt size.
3. Explain findings before changing configuration.
4. Use `ctxwise profile ... --install` only when the user explicitly requests the
   install; report the backup path.

## Cost rules

- API-key mode may show a dated token-based charge estimate.
- ChatGPT subscription mode shows tokens, credit equivalent, and quota when
  available. Do not call included usage a dollar charge.
- Add `--api-equivalent` only when the user asks for the comparison. Preserve
  the label `comparison only; not charged`.
- Keep missing values as `unknown`; never replace them with zero.
- Keep aggregate turn input separate from prompt-window occupancy.
- Do not claim savings without a comparable, quality-passing baseline.

## Safety and privacy

- Do not read Codex session transcripts unless the user supplies a specific file.
- Do not print config values, credentials, cookies, or environment secrets.
- Do not relay authentication or attempt to bypass ChatGPT limits.
- Prefer dry-run and staged output. Inspect generated TOML before installation.

If `ctxwise` is missing, stop and recommend `npm install --global @framy2/ctxwise` rather
than silently recreating its calculations in the model response.
