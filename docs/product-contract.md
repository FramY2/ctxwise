# CtxWise v0.1 product contract

CtxWise is a local-first diagnostic and control layer for OpenAI Codex. It does
not proxy authentication, bypass plan limits, or send prompts to a third-party
service.

## Shipped guarantees

1. **Context X-Ray** inspects either Codex's model-visible `prompt-input` JSON or
   the local Codex configuration surface. Estimates are labelled as estimates.
2. **Setup audit** inventories configuration, `AGENTS.md`, skills, agents, and
   MCP declarations without reading session transcripts by default.
3. **Local context map** renders bounded Mermaid from audit metadata so large
   guidance and discovery-heavy skills are visible without a hosted service.
   Configuration text and unobserved tool schemas are never folded into a
   fictional token total.
4. **Profile compiler** turns a reviewable YAML policy into native Codex profile
   TOML. It writes to a staging directory unless the user explicitly requests an
   install, and installed files are backed up before replacement.
5. **Context receipt** keeps an opt-in, estimated pre-turn prompt X-Ray separate
   from exact aggregate usage parsed from `codex exec --json`. It never presents
   aggregate input consumption as context-window occupancy. The footer is
   generated locally, so it does not consume model tokens.
6. **Cost honesty** keeps three concepts separate:
   - API-key mode: token-based API charge estimate.
   - ChatGPT subscription mode: token counts, credit equivalent, and available
     quota snapshot.
   - Optional API equivalent: comparison only, disabled by default and always
     labelled “not charged”.
7. **Capability lockfile** hashes the effective local context surface while
   redacting credentials and environment-variable values.
8. **Offline by default**: no telemetry, hosted account, API key, database, or
   model call is required for audit, X-Ray, profiles, receipts, or lockfiles.
9. **Capability drift guard** compares schema-validated, redacted lockfiles and
   reports additions, removals, and changes deterministically. CI failure is
   explicit through `--fail-on-drift`; prompt history remains out of scope.
10. **Context budget guard** checks only estimated known startup context and its
    largest known contributor against explicit limits. Config/profile and MCP
    tool-schema surfaces stay unknown; they can block CI only through explicit
    policy. The command does not call a model or write configuration.

## Non-goals for v0.1

- Replacing Codex's native `/status`, `/usage`, or `/statusline` views.
- Claiming that estimated characters are exact model tokens.
- Converting included ChatGPT usage into money “spent”.
- Reading browser cookies or relaying ChatGPT sessions.
- Automatically rewriting user configuration without a diff and backup.
- Claiming savings without a comparable, quality-passing baseline.

## Measurement vocabulary

- `exact`: returned by Codex runtime or an OpenAI API usage object.
- `estimated`: derived from an explicit rate card or character proxy.
- `unknown`: unavailable; never represented as zero.

The built-in rate catalog is versioned and includes its effective date and
official source URLs. Users can supply a newer catalog without upgrading CtxWise.
