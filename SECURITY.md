# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0.0 | No        |

## Report privately

When the repository is public, use GitHub private vulnerability reporting.
Please do not open a public issue for a vulnerability that could expose prompts,
credentials, account data, or arbitrary file/process access.

Include:

- affected version and operating system;
- minimal reproduction with synthetic data;
- impact and affected command;
- suggested mitigation, if known.

Never include real API keys, cookies, access tokens, private prompts, or session
transcripts. Maintainers will acknowledge a complete report, validate it, and
coordinate a fix and disclosure timeline appropriate to severity.

## Security boundaries

CtxWise is a local developer tool, not a sandbox. It reads the paths selected by
the user and can explicitly install Codex profile files. Run it only in workspaces
and with configuration you trust.
