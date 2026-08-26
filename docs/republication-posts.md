# Republication drafts — CtxWise

Use the public name **CtxWise** (formerly CtxRay) and the package
**`@framy2/ctxwise`**.
Do not paste the same body into every channel. Post one channel at a time.
Verify every URL before sending. Automation must not press submit.

Primary CTA: one independent two-turn reproduction in
[Issue #1](https://github.com/FramY2/ctxwise/issues/1).

## v0.4.0 utility-first update

Use this for release follow-ups instead of repeating the benchmark-first copy:

> CtxWise v0.4.0 now answers the smallest useful question in one local command:
> what is Codex carrying before this task?
>
> `npx @framy2/ctxwise snapshot`
>
> It ranks known guidance and skill-discovery contributors, keeps config and MCP
> schema coverage gaps explicitly unknown, suggests safe next actions, calls no
> model/API, uploads nothing, and changes no configuration.
>
> Example and source: https://github.com/FramY2/ctxwise#see-what-codex-carries-in-one-command

Already published — do not repost these as if they were new:

- Show HN: <https://news.ycombinator.com/item?id=49238209>
- Reddit `r/OpenaiCodex` (72-hour window closed 16 August — do not repost):
  <https://www.reddit.com/r/OpenaiCodex/comments/1vnlilf/i_fixed_two_flaws_in_my_codex_context_benchmark/>

## 1. GitHub Discussions — openai/codex Show and tell

**Where:** <https://github.com/openai/codex/discussions/categories/show-and-tell>

**Title:** CtxWise: local context audits and a two-turn reproduction command

**Body:**

```
Disclosure: I maintain CtxWise (`@framy2/ctxwise`), formerly published as
CtxRay. Not affiliated with OpenAI. Also not the unrelated PyPI project
named `ctxray`.

Codex setups quietly accumulate instructions, skills, plugins, agents, and
MCP declarations. CtxWise is a local-first CLI and explicitly
invoked plugin that shows that surface, compiles reviewable native profiles,
and locks it so CI can detect drift. It does not call a model, proxy auth,
upload prompts, or add telemetry.

The first maintainer 10-pair Luna/Terra/Sol microbenchmark had 20/20 answers
pass the same validators while the lean profiles used 29.1% fewer exact
aggregate turn tokens. A second maintainer run measured 28.5% across nine
conservative pairs and disclosed one stale validator. An external review
found a nested-guidance audit bug, fixed in v0.2.2. The first external PR
added targeted task selection, shipped as `npm run benchmark:quick` in
v0.2.4. Current checkout is v0.3.2 (version-sync fix; same command, not a
new matrix). Independent reproductions so far: 0.

Those are bounded maintainer results, not independent validation. I am
looking for one unrelated environment where this either succeeds or fails
reproducibly:

    git clone https://github.com/FramY2/ctxwise.git
    cd ctxwise
    git checkout v0.3.2
    npm ci
    npm run benchmark:quick

It states the two-turn quota cost up front, writes a local `community-*`
ledger plus `share.md` and checksums, and uploads nothing.

Repo, method, limitations, and Issue #1:
https://github.com/FramY2/ctxwise
```

## 2. OpenAI Developer Community — Codex category

**Where:** <https://community.openai.com/c/codex/37>

**Title:** Looking for one independent reproduction of a Codex context benchmark

**Body:**

```
Disclosure: I maintain CtxWise, an Apache-2.0 local-first CLI/plugin
for auditing and locking Codex context. Package: `@framy2/ctxwise`. Distinct
from the unrelated PyPI project named `ctxray`.

I already published a quality-gated maintainer matrix (20/20 validator
passes, 29.1% then 28.5% fewer exact aggregate turn tokens on lean
profiles) and later found two problems of my own: a nested `AGENTS.md` audit
gap (fixed in v0.2.2) and a reproduction path that could reuse the bundled
ledger and run zero new turns (fixed in v0.2.3/v0.2.4). Current release is
v0.3.2. Independent reproductions so far: 0.

What I still do not have is an independent two-turn run from someone else's
Codex setup. The smallest command after cloning v0.3.2 is:

`npm run benchmark:quick`

It may consume two Codex turns, creates a fresh local ledger, and never
uploads artifacts. Success or a reproducible failure both count. I will
verify independence in https://github.com/FramY2/ctxwise/issues/1 rather
than assert it from the tool.

Method, raw ledgers, checksums, and limitations:
https://github.com/FramY2/ctxwise
```

## 3. Awesome Codex Plugins — pull-request text

**Where:** <https://github.com/hashgraph-online/awesome-codex-plugins>

**Title:** Add CtxWise (`@framy2/ctxwise`)

**Body:**

```
Adds CtxWise, a local-first context audit, profile compiler, drift
guard, and usage-receipt CLI/plugin for OpenAI Codex.

- Name: CtxWise
- Install: `npm install --global @framy2/ctxwise`
- Repo: https://github.com/FramY2/ctxwise
- License: Apache-2.0
- Invocation: explicit `$ctxwise` skill only; no implicit hooks
- Privacy: no telemetry, no prompt upload, no auth proxy

Not the PyPI project named ctxray. Machine IDs remain `ctxwise` /
`@framy2/ctxwise`.
```

Check the catalog's current list format before opening the PR. Match their
existing entry shape instead of forcing this markdown.

## 4. Unofficial Codex Plugin Marketplace

**Where:** <https://www.codex-marketplace.com/submit>

**Suggested fields:**

- Name: CtxWise
- Repository: `https://github.com/FramY2/ctxwise`
- Package: `@framy2/ctxwise`
- Short description: Local-first Codex context audit, lock, drift detection, and honest usage receipts.
- Notes: Community project, not affiliated with OpenAI. Explicit-invocation plugin only. Distinct from the PyPI project named ctxray.

## 5. DEV Community — `#showdev` article

**Where:** <https://dev.to/t/showdev/>

**Title:** I found two flaws in my own Codex benchmark — here is how I made it reproducible

**Draft:**

```
I maintain CtxWise, a local-first CLI that audits what OpenAI Codex
loads before a task. This is not a launch post. It is the record of two
mistakes I made in public and the command I now want strangers to run.

## The product, briefly

Codex setups accumulate instructions, skills, plugins, agents, and MCP
servers. CtxWise inventories that surface locally, compiles
reviewable native profiles, and writes a redacted lockfile so CI can detect
drift. It does not call a model or upload prompts.

Package: `@framy2/ctxwise`. Distinct from the unrelated PyPI project named
`ctxray`.

## Mistake 1: the audit could skip parent AGENTS.md files

An external review found that a nested working directory could omit
root and intermediate `AGENTS.md` files. That is exactly the class of
context the tool exists to make visible. v0.2.2 follows Codex root markers
and the active root-to-CWD guidance chain. The RED/GREEN tests are in the
repo.

## Mistake 2: the "reproduction" command could do no work

While asking for independent runs, I found that the documented preflight
could treat the committed maintainer ledger as complete and execute zero
new Codex turns. That is a reproducibility trap I wrote myself.

v0.2.3 and v0.2.4 replace that path with a fresh `community-*` ledger.
Current checkout is v0.3.2. The smallest useful command is now:

    git clone https://github.com/FramY2/ctxwise.git
    cd ctxwise
    git checkout v0.3.2
    npm ci
    npm run benchmark:quick

It states the two-turn quota cost first, writes `share.md` and SHA-256
checksums locally, and uploads nothing.

## What I will not claim

The maintainer matrices measured 29.1% and then 28.5% fewer exact
aggregate turn tokens at the same validators. Those are bounded
maintainer results. They are not independent validation and not a
universal savings number.

If you run the two-turn command, report success or failure in
https://github.com/FramY2/ctxwise/issues/1. I will verify independence
there.
```

## 6. Hold until there is independent evidence

- **Console.dev** (`hello@console.dev`): send after one verified independent
  reproduction. Emphasize local-first CLI, Apache-2.0, and the public
  benchmark method.
- **Product Hunt:** wait for the PNG social preview re-export, a coherent
  landing identity, and at least one external reproduction. Use the name
  CtxWise, not the bare short name.

## Posting order

1. GitHub Show and tell.
2. Next day: OpenAI Developer Community.
3. Then the Awesome Codex Plugins PR and marketplace submit.
4. Two or three days later: DEV article.
5. After one independent reproduction: Console.dev.
6. After branding assets and evidence: Product Hunt.

Do not add another Reddit, HN, or generic-forum post during this sequence.
