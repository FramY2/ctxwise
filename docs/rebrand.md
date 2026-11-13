# CtxWise rename

Formerly **CtxRay**. Public name, CLI, npm package, plugin, and lockfile
generator are now **CtxWise** / `ctxwise` / `@framy2/ctxwise`.

This leaves the unrelated PyPI project
[`ctxray`](https://pypi.org/project/ctxray/) while keeping the `ctx` prefix.
Exact `ctxwise` was free on npm, PyPI, crates.io, and GitHub repository names
when checked on 14 August 2026. Nearby names such as ContextWise (Chrome
extension / Japanese Q&A saver) are different products.

## What changed

| Surface                            | New value                                        |
| ---------------------------------- | ------------------------------------------------ |
| Public name                        | CtxWise                                          |
| npm                                | `@framy2/ctxwise`                                |
| CLI                                | `ctxwise` (`ctxray` remains a one-release alias) |
| Plugin / skill                     | `ctxwise` / `$ctxwise`                           |
| Lockfile generator written         | `ctxwise`                                        |
| Lockfile generator accepted        | `ctxwise` or `ctxray`                            |
| GitHub (after the Settings rename) | `FramY2/ctxwise`                                 |
| Brand files                        | `assets/brand/ctxwise-*`                         |

## What stayed

- Historical benchmark ledgers under `benchmarks/results/` are frozen evidence.
- Published `@framy2/ctxray` artifacts remain on npm until a later deprecate
  notice. They are not this tree anymore.
- The leftover empty `plugin/` tree is unused.

## GitHub

Rename `FramY2/ctxray` to `FramY2/ctxwise` in repository Settings. Do not
create a new empty `ctxray` repo: that would break redirects.

Then update the local remote:

```shell
git remote set-url origin https://github.com/FramY2/ctxwise.git
```

Re-point npm trusted publishing at `@framy2/ctxwise` and `FramY2/ctxwise`
before the next release.

## Follow-up

- Re-export `assets/brand/ctxwise-social-preview.png` from the SVG if GitHub
  still shows the old wordmark.
- Publish `@framy2/ctxwise` and add a deprecation README on `@framy2/ctxray`.
