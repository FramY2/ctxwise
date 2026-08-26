# CtxWise v0.4.0 — one command before the task

CtxWise now gives a useful answer before asking a new user to understand the
whole audit model or spend quota on a benchmark:

```shell
npx @framy2/ctxwise snapshot
```

The command runs locally, calls no model or API, reads no session transcript,
and changes no configuration. It reports:

- the estimated known startup-token surface;
- the largest guidance and skill-discovery contributors;
- counts for guidance, skills, plugins, and MCP servers;
- configuration and MCP surfaces that remain unknown rather than being counted
  as zero;
- bounded next actions for warnings such as a large skill catalog or duplicate
  skill metadata.

This release also updates Vitest to 4.1.11 and tightens the public product
positioning around observability, safety, and reproducibility.

The existing benchmark remains available as supporting evidence, not the first
thing a new user is asked to run.
