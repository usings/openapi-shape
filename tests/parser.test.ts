import { afterEach, describe, expect, it, vi } from "vitest";
import { readSource } from "../src/parser";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

describe("readSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a local JSON file", async () => {
    const doc = await readSource(join(import.meta.dirname, "fixtures/petstore.json"));
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.paths).toBeDefined();
    expect(doc.components.schemas.Pet).toBeDefined();
  });

  it("throws on non-existent file", async () => {
    await expect(readSource("/tmp/does-not-exist.json")).rejects.toThrow();
  });

  it("throws on invalid JSON", async () => {
    const tmp = "/tmp/openapi-dts-test-invalid.json";
    await writeFile(tmp, "not json");
    await expect(readSource(tmp)).rejects.toThrow();
    await unlink(tmp);
  });

  it("fetches an http(s) URL and parses JSON", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response('{"openapi":"3.1.0","paths":{}}', { status: 200 }));
    const doc = await readSource("https://example.com/openapi.json");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/openapi.json");
    expect(doc.openapi).toBe("3.1.0");
  });

  it("throws with status info on non-2xx HTTP response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );
    await expect(readSource("https://example.com/missing.json")).rejects.toThrow(/404/);
  });

  it("returns a doc with parameter $refs pre-resolved", async () => {
    const tmp = "/tmp/openapi-dts-parser-test.json";
    const { writeFile, unlink } = await import("node:fs/promises");
    await writeFile(
      tmp,
      JSON.stringify({
        components: {
          parameters: { P: { name: "p", in: "query", schema: { type: "string" } } },
        },
        paths: {
          "/x": {
            get: { parameters: [{ $ref: "#/components/parameters/P" }], responses: {} },
          },
        },
      }),
    );
    try {
      const doc = await readSource(tmp);
      expect(doc.paths["/x"].get.parameters[0].name).toBe("p");
    } finally {
      await unlink(tmp);
    }
  });
});
