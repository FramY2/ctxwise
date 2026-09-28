# CtxWise v0.5.0 — context budget guard

`ctxwise budget` turns the local context snapshot into a reviewable guardrail.
Set a one-off limit with command flags or commit a small strict YAML policy for
CI. The command reports estimates, identifies the largest known contributor,
and keeps unmeasured config/profile and MCP surfaces explicitly unknown.

```shell
npx @framy2/ctxwise budget --max-known-tokens 4000 --fail-on-exceed
```

Start from [`examples/ctxwise.budget.yaml`](https://github.com/FramY2/ctxwise/blob/v0.5.0/examples/ctxwise.budget.yaml):

```shell
ctxwise budget --policy ctxwise.budget.yaml --fail-on-exceed
```

`--fail-on-exceed` returns exit code `2` only for a numeric violation, or for
unmeasured surfaces when the policy explicitly sets `unknown: fail`, or an
audit error that prevents a reliable result. It never
claims an exact context-window measurement, calls a model, or writes settings.
