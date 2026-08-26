# CtxWise v0.4.0 launch kit

## Positioning

Lead with immediate utility, not token-savings claims:

> See what Codex carries before a task — locally, in one command.

Primary command:

```shell
npx @framy2/ctxwise snapshot
```

Proof points:

- no model or API call;
- no API key;
- no telemetry or prompt upload;
- no session transcript read;
- no automatic config changes;
- unknown config/MCP surfaces remain unknown rather than zero.

## GitHub release/discussion copy

> CtxWise v0.4.0 adds `snapshot`: a one-command local context health check for
> Codex. It ranks the largest known guidance and skill-discovery contributors,
> names coverage gaps, and suggests safe next actions. The command calls no
> model/API and changes no configuration.
>
> Try it without installing globally:
>
> `npx @framy2/ctxwise snapshot`
>
> This release deliberately moves the benchmark to supporting evidence. The
> first user experience is now a useful result that costs no Codex turn.

## Partner-maintainer note

> Disclosure: I maintain CtxWise. Your project manages or reduces AI-agent
> context, so I am checking whether a read-only CtxWise snapshot would be useful
> as a compatibility diagnostic. It calls no model, uploads nothing, and changes
> no configuration. If you are open to a three-minute check, please run
> `npx @framy2/ctxwise snapshot --json` in a representative Codex setup and
> report either useful output or a failure. I will not describe the result as
> independent validation without your confirmation.

Do not post this note indiscriminately. Use it only where the project already
manages AGENTS.md, skills, plugins, MCP configuration, or Codex context.
