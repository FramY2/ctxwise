# Cost semantics: why subscription dollars are opt-in

## Decision

CtxWise keeps the API-equivalent feature, but disables it by default for ChatGPT
subscriptions. This avoids turning a useful comparison into a misleading
per-message invoice.

## Why it is a double-edged feature

The comparison is useful because it makes cache hits, model routing, and large
contexts understandable in a familiar unit. It can also help API users verify
the order of magnitude of a real bill.

It becomes harmful when:

- an included Plus or Pro turn is presented as money the user just spent;
- a dated API rate is treated as a stable subscription exchange rate;
- ChatGPT credits are converted to dollars even though they have no cash value;
- missing tool fees or cache-write tokens are hidden;
- a scary number encourages lower-quality routing without an evaluation.

## Display contract

| Mode                       | Tokens                          | Credits             | Quota                         | USD                            |
| -------------------------- | ------------------------------- | ------------------- | ----------------------------- | ------------------------------ |
| `apikey`                   | Exact when runtime reports them | Not shown           | Not applicable                | `estimated API charge`         |
| `chatgpt`                  | Exact when runtime reports them | `credit equivalent` | Exact snapshot when available | Hidden                         |
| `chatgpt --api-equivalent` | Exact when runtime reports them | `credit equivalent` | Exact snapshot when available | `comparison only; not charged` |
| Unknown auth/model         | Exact tokens when available     | Unknown             | Unknown                       | Unknown                        |

The CLI must never print `spent $…` for subscription use.

## Formula

For a priced model, aggregate token categories use this base formula:

```text
uncached_input = input_tokens - cached_input_tokens
value = (
  uncached_input × input_rate
  + cached_input_tokens × cached_input_rate
  + output_tokens × output_rate
) / 1,000,000
```

Reasoning output is not added again when it is already included in the runtime's
output-token total. For GPT-5.6 prompts above the published long-context
threshold, CtxWise applies the published multipliers to the API estimate only.
The ChatGPT credit rate card does not publish an equivalent long-context
multiplier, so CtxWise does not invent one.

`turn.completed.input_tokens` can aggregate multiple model calls and is not a
context-window snapshot. CtxWise uses the separate pre-turn `--prompt-xray`
estimate to decide whether the initial prompt crosses the API long-context
threshold. Later calls can cross it independently, so the result remains an
estimate and the CLI prints that limitation.

## Evidence labels

- Token counters from `turn.completed`: **exact**.
- Prompt size from model-visible JSON plus the character proxy: **estimated**.
- Quota percentage from `account/rateLimits/read`: **exact snapshot**.
- API or credit arithmetic: **estimated**, because the catalog is dated and
  some fee classes may not be visible in the event.
- Missing fields: **unknown**, never zero.

## What CtxWise intentionally omits

- A universal credit-to-dollar exchange rate.
- “Savings” against an unmeasured baseline.
- Weekly-quota conversion inferred from local token estimates.
- Context-fill percentages derived from aggregate turn consumption.
- Subscription cost per prompt. A future retrospective amortized metric may
  divide a user-provided subscription price across quality-passing work, but it
  would remain a planning metric, not an OpenAI charge.

## Product positioning

CtxWise should be described as an observability, safety, and reproducibility tool,
not a way to evade payment or bypass limits. Efficient context and right-sized
models reduce waste while making Codex more reliable. OpenAI's own Codex pricing
guidance recommends smaller models and tighter scope when appropriate.

This avoids the risky framing of “beating quota” and keeps the product focused
on engineering value beyond a chatbot wrapper.

## Sources

- [Codex pricing and token-based credit rate card](https://learn.chatgpt.com/docs/pricing)
- [ChatGPT credits FAQ](https://help.openai.com/en/articles/12642688)
- [OpenAI API model comparison and prices](https://developers.openai.com/api/docs/models/compare)
