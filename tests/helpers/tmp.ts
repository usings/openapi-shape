import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** Write `files` (relative path → content) into a fresh directory, run `fn`, then clean up. */
export async function withFiles<T>(
  files: Record<string, string | object>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "openapi-shape-"))
  try {
    await Promise.all(
      Object.entries(files).map(async ([name, content]) => {
        const path = join(dir, name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(
          path,
          typeof content === "string" ? content : JSON.stringify(content, null, 2),
        )
      }),
    )
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
