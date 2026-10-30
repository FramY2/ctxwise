import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  queryAccountSnapshot,
  quotaFromResult,
  renderAccountSnapshot,
} from "../../src/app-server.js";

const fakeCodex = fileURLToPath(
  new URL("../fixtures/fake-codex.mjs", import.meta.url),
);

describe("queryAccountSnapshot", () => {
  it("performs the handshake and reads plan plus rate limits", async () => {
    const result = await queryAccountSnapshot({
      command: process.execPath,
      commandPrefixArgs: [fakeCodex],
      timeoutMs: 2_000,
    });

    expect(result.authMode).toBe("chatgpt");
    expect(result.planType).toBe("plus");
    expect(result.quota?.usedPercent).toBe(37);
    expect(result.quota?.provenance).toBe("exact");
  });

  it("extracts both primary (5h) and secondary (weekly) quota windows and renders them cleanly", () => {
    const quota = quotaFromResult({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: 1_900_000_000,
        },
        secondary: {
          usedPercent: 18,
          windowDurationMins: 10_080,
          resetsAt: 1_900_600_000,
        },
      },
    });

    expect(quota?.usedPercent).toBe(42);
    expect(quota?.primary?.usedPercent).toBe(42);
    expect(quota?.secondary?.usedPercent).toBe(18);
    expect(quota?.secondary?.windowDurationMins).toBe(10_080);

    const rendered = renderAccountSnapshot({
      authMode: "chatgpt",
      planType: "pro",
      quota,
      secondaryQuota: quota?.secondary ?? null,
    });
    expect(rendered).toContain("Plan pro");
    expect(rendered).toContain("5h 42% used");
    expect(rendered).toContain("weekly 18% used");
  });

  it("rejects cleanly when the Codex executable is unavailable", async () => {
    await expect(
      queryAccountSnapshot({
        command: "ctxwise-command-that-does-not-exist",
        timeoutMs: 500,
      }),
    ).rejects.toThrow();
  });
});
