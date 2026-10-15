import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function cleanupDirectories(paths: string[]): Promise<void> {
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
}

export async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}
