# Reproduce the current CtxWise benchmark and report what you observe

CtxWise v0.4.0 includes an immediate local context snapshot plus a
quality-gated Luna/Terra/Sol microbenchmark and a
two-turn, single-task community command. We are looking for independent
reproductions, regressions, and cases where reducing discovered context changes
an answer.

## Two-turn reproduction

1. Clone <https://github.com/FramY2/ctxwise> and check out tag `v0.4.0`.
2. Install Node.js 20+ and a working Codex CLI.
3. Run `npm ci`, then `npm run benchmark:quick`.
4. The command may consume two Codex turns. It prints a new `community-*` ID
   and writes `share.md`, `summary.json`, `report.md`, and `SHA256SUMS.txt`.
5. Review the files and paste `share.md` in this issue. Attach or link the other
   artifacts if you are comfortable sharing them.

To select a different task, run
`npm run benchmark:reproduce -- --task semantic-version`. Use a fresh ID for a
different filtered task; CtxWise refuses to mix unrelated tasks in one scoped
ledger.

Please do not include credentials, private repository contents, or private
Codex data. Share only reviewed generated artifacts and any reproducible
discrepancy. Failures are as valuable as savings. A generated report does not
certify independence; the maintainer verifies that separately.
