# Repository instructions

- Keep CtxWise local-first and model-independent.
- Never read Codex session transcripts by default.
- Preserve `exact`, `estimated`, and `unknown` as distinct evidence states.
- Never label subscription API-equivalent dollars as money charged or spent.
- Add or update tests before changing calculation, redaction, profile, or process behavior.
- Run `npm run check`, `npm run build`, `npm run validate:plugin`, and
  `npm pack --dry-run` before release.
- Keep the plugin skill explicitly invoked and free of background hooks.
- Update the dated catalog only from official OpenAI sources and include the
  effective date in the file name and payload.
