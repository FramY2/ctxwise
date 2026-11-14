import { z } from "zod";

import type { CapabilityLock, CapabilityLockEntry } from "./lockfile.js";

const capabilityLockEntrySchema = z
  .object({
    scope: z.enum(["codex-home", "project"]),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    redacted: z.boolean(),
  })
  .strict();

const capabilityLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    generator: z
      .object({
        name: z.enum(["ctxwise", "ctxray"]),
        version: z.string().min(1),
      })
      .strict(),
    generatedAt: z.string().datetime({ offset: true }),
    provenance: z.literal("local-files"),
    includeMultiAgent: z.boolean().optional(),
    entries: z.array(capabilityLockEntrySchema),
  })
  .strict();

export type CapabilityDriftChange = {
  change: "added" | "removed" | "changed";
  scope: CapabilityLockEntry["scope"];
  path: string;
  before?: Pick<CapabilityLockEntry, "sha256" | "bytes" | "redacted">;
  after?: Pick<CapabilityLockEntry, "sha256" | "bytes" | "redacted">;
};

export interface CapabilityDriftReport {
  schemaVersion: 1;
  status: "clean" | "drifted";
  baselineGeneratedAt: string;
  currentGeneratedAt: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    total: number;
    bytesDelta: number;
  };
  changes: CapabilityDriftChange[];
}

function entryKey(entry: Pick<CapabilityLockEntry, "scope" | "path">): string {
  return `${entry.scope}/${entry.path}`;
}

function comparableEntry(entry: CapabilityLockEntry) {
  return {
    sha256: entry.sha256,
    bytes: entry.bytes,
    redacted: entry.redacted,
  };
}

function indexEntries(
  entries: CapabilityLockEntry[],
): Map<string, CapabilityLockEntry> {
  const indexed = new Map<string, CapabilityLockEntry>();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (indexed.has(key)) {
      throw new Error(`Capability lockfile contains duplicate entry: ${key}`);
    }
    indexed.set(key, entry);
  }
  return indexed;
}

export function parseCapabilityLock(value: unknown): CapabilityLock {
  const parsed = capabilityLockSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Not a valid CtxWise capability lockfile (schema version 1).",
      {
        cause: parsed.error,
      },
    );
  }
  const { includeMultiAgent, ...rest } = parsed.data;
  const lock: CapabilityLock = {
    ...rest,
    ...(includeMultiAgent === undefined ? {} : { includeMultiAgent }),
  };
  indexEntries(lock.entries);
  return lock;
}

export function compareCapabilityLocks(
  baseline: CapabilityLock,
  current: CapabilityLock,
): CapabilityDriftReport {
  const baselineEntries = indexEntries(baseline.entries);
  const currentEntries = indexEntries(current.entries);
  const keys = [
    ...new Set([...baselineEntries.keys(), ...currentEntries.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  const changes: CapabilityDriftChange[] = [];

  for (const key of keys) {
    const before = baselineEntries.get(key);
    const after = currentEntries.get(key);
    if (!before && after) {
      changes.push({
        change: "added",
        scope: after.scope,
        path: after.path,
        after: comparableEntry(after),
      });
      continue;
    }
    if (before && !after) {
      changes.push({
        change: "removed",
        scope: before.scope,
        path: before.path,
        before: comparableEntry(before),
      });
      continue;
    }
    if (
      before &&
      after &&
      (before.sha256 !== after.sha256 ||
        before.bytes !== after.bytes ||
        before.redacted !== after.redacted)
    ) {
      changes.push({
        change: "changed",
        scope: after.scope,
        path: after.path,
        before: comparableEntry(before),
        after: comparableEntry(after),
      });
    }
  }

  const added = changes.filter(({ change }) => change === "added").length;
  const removed = changes.filter(({ change }) => change === "removed").length;
  const changed = changes.filter(({ change }) => change === "changed").length;
  const baselineBytes = baseline.entries.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  const currentBytes = current.entries.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );

  return {
    schemaVersion: 1,
    status: changes.length === 0 ? "clean" : "drifted",
    baselineGeneratedAt: baseline.generatedAt,
    currentGeneratedAt: current.generatedAt,
    summary: {
      added,
      removed,
      changed,
      total: changes.length,
      bytesDelta: currentBytes - baselineBytes,
    },
    changes,
  };
}
