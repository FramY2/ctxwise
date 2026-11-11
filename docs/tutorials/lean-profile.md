# Walkthrough: from an audit finding to a lean profile

This walkthrough is one end-to-end pass: run an audit, read one finding,
answer it with a small YAML policy, preview the native Codex profile that
policy compiles to, and verify the result with an acceptance check.

Everything below uses a fictional demo project, **Acme Notes**, with
fictional paths. The command outputs are real; the project is not. Token
figures are labelled **exact**, **estimated**, or **unknown** throughout,
and no saving percentage is claimed: what a lean profile saves depends on
the setup it replaces, which this walkthrough does not measure.

## The demo project

```text
acme-notes/
├── AGENTS.md
└── .agents/
    └── skills/
        ├── release-notes/
        │   └── SKILL.md
        └── changelog-draft/
            └── SKILL.md
```

`AGENTS.md` is a short guidance file (406 characters). Each skill is a
`SKILL.md` with a `name` and a one-line `description` in its frontmatter —
and, the mistake this walkthrough is built around, both skills advertise
the **same** description: "Draft release notes for the fictional Acme
Notes app."

## Step 1 — Audit, and read one finding

```bash
npx @framy2/ctxwise audit --json
```

The audit inventories your config, guidance files, skills, plugins, and
MCP servers. It reports counts and paths only — never prompt text — so
its output is safe to paste into an issue or a review. The relevant part
of the output:

```json
{
  "provenance": "estimated",
  "sources": [
    {
      "kind": "agents-guidance",
      "contextRole": "prompt",
      "path": "project/AGENTS.md",
      "characters": 406,
      "estimatedTokens": 102
    }
  ],
  "catalogDescriptionCharacters": 134,
  "estimatedKnownStartupTokens": 136,
  "findings": [
    {
      "code": "duplicate-skill-description",
      "severity": "warning",
      "message": "Multiple skills advertise the same description and may create ambiguous startup context.",
      "paths": [
        "project/.agents/skills/changelog-draft/SKILL.md",
        "project/.agents/skills/release-notes/SKILL.md"
      ]
    }
  ]
}
```

The finding, `duplicate-skill-description`, means the startup catalog
carries two skills the model cannot tell apart by description. When a
task matches that description, either skill may be picked, and both
catalog entries are paid for in every session whether they are used or
not. The fix on the content side is small: give each skill a description
that says what makes it different, or delete the duplicate. The rest of
this walkthrough covers the configuration side: a profile that keeps the
session itself bounded while you make that call.

Note the evidence states in this output. The character count (406) is
**exact** — it is counted from the file. The token figures (102 for the
guidance file, 136 known startup tokens in total) are **estimated**,
which the report says outright in its `provenance` field. Nothing here is
presented as an exact token count.

## Step 2 — Answer with a small policy, and preview it

A lean profile is a reviewable YAML policy: a cheaper default model, low
reasoning effort, and one thread, so a bounded task stays bounded. Save
this as `lean.yaml` (the format follows
[`examples/ctxwise.yaml`](../../examples/ctxwise.yaml)):

```yaml
version: 1
profiles:
  lean:
    description: Fast, bounded work and deterministic inspection.
    model: gpt-5.6-luna
    reasoningEffort: low
    approvalPolicy: on-request
    sandboxMode: workspace-write
    agents:
      maxThreads: 1
      defaultModel: gpt-5.6-luna
      defaultEffort: low
```

Compile it to the native Codex profile without writing anything:

```bash
npx @framy2/ctxwise profile lean.yaml --dry-run
```

```toml
# lean.config.toml
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[agents]
max_concurrent_threads_per_session = 1
default_subagent_model = "gpt-5.6-luna"
default_subagent_reasoning_effort = "low"
```

Read the TOML before you install it — that is the review step. It says:
one model at low effort for the main turn and for subagents, approvals
on request, writes limited to the workspace, and a single thread, so a
"quick look" cannot fan out into parallel subagent work. When the TOML
says what you intended, drop `--dry-run` (or add `--install`) to write
`lean.config.toml` into your Codex home with backups. From then on the
profile is selected by name, e.g. `codex --profile lean`.

## Step 3 — Verify with a task-specific acceptance check

A profile is only good if a real task still passes under it. Write the
check before you run the task, and make it specific to the task:

1. **Context check (runs anywhere).** The known startup cost stays
   inside the budget you set:

   ```bash
   npx @framy2/ctxwise budget --max-known-tokens 500
   ```

   ```text
   CtxWise budget · within-budget · ~136 known startup tokens (estimated)
   - Known startup limit: 500 tokens
   - Largest known contributor: ~102 · project/AGENTS.md
   ```

   Exit code 0. Both figures are **estimated**, as labelled. If you fixed
   the duplicate description from step 1, re-run `audit --json` too: the
   `duplicate-skill-description` finding should be gone.

2. **Task check (needs your Codex setup).** Pick one small, fixed task
   with a checkable answer — for this project: "List the working rules
   from AGENTS.md as bullets." Run it under the profile with a receipt:

   ```bash
   npx @framy2/ctxwise run --profile lean --receipt "List the working rules from AGENTS.md as bullets"
   ```

   Accept the profile for this kind of task only if the answer names the
   rules from `AGENTS.md` (all of them, none invented) **and** the
   receipt's usage is in the range a low-effort, single-thread turn
   should use. The receipt's token figures are **exact** — they come
   from the `codex exec --json` usage record, not from an estimate.
   MCP tool-schema tokens, by contrast, stay **unknown** to the audit:
   it inventories server names without probing their schemas, and says
   so when servers are present.

If either check fails, the profile is wrong for that task — adjust the
policy (model, effort, threads) and re-run the dry-run preview before
installing again.
