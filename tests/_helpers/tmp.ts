import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TmpOpts {
  ext?: string;
  prefix?: string;
}

export async function withTmpFile<T>(
  content: string,
  fn: (path: string) => Promise<T>,
  opts?: TmpOpts,
): Promise<T> {
  return withTmpFiles([content], async ([p]) => fn(p), opts);
}

export async function withTmpFiles<T>(
  contents: string[],
  fn: (paths: string[]) => Promise<T>,
  opts?: TmpOpts,
): Promise<T> {
  const paths = contents.map((_, i) => makeTmpPath(opts, i));
  await Promise.all(contents.map((c, i) => writeFile(paths[i], c)));
  try {
    return await fn(paths);
  } finally {
    await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
  }
}

export async function withTmpPath<T>(fn: (path: string) => Promise<T>, opts?: TmpOpts): Promise<T> {
  const path = makeTmpPath(opts);
  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => {});
  }
}

function makeTmpPath(opts: TmpOpts | undefined, index = 0): string {
  const ext = opts?.ext ?? ".json";
  const prefix = opts?.prefix ?? "openapi-shape";
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpdir(), `${prefix}-${stamp}-${index}${ext}`);
}
