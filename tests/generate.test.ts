import { describe, expect, it } from "vitest";
import { generateFromSource } from "../src/index";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

describe("generate (integration)", () => {
  it("generates correct output for petstore fixture", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/petstore.json"));
    expect(code).toMatchSnapshot();
  });

  it("generates correct output for edge-cases fixture", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/edge-cases.json"));
    expect(code).toMatchSnapshot();
  });

  it("generated code is valid as .d.ts and passes tsc --noEmit", async () => {
    const petstoreCode = await generateFromSource(
      join(import.meta.dirname, "fixtures/petstore.json"),
    );
    const edgeCasesCode = await generateFromSource(
      join(import.meta.dirname, "fixtures/edge-cases.json"),
    );

    const tmpPetstore = "/tmp/openapi-dts-test-petstore.d.ts";
    const tmpEdgeCases = "/tmp/openapi-dts-test-edge-cases.d.ts";

    await Promise.all([
      writeFile(tmpPetstore, petstoreCode),
      writeFile(tmpEdgeCases, edgeCasesCode),
    ]);

    try {
      const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
      await expect(
        run(tsc, [
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--target",
          "esnext",
          tmpPetstore,
          tmpEdgeCases,
        ]),
      ).resolves.toBeUndefined();
    } finally {
      await Promise.all([unlink(tmpPetstore), unlink(tmpEdgeCases)]);
    }
  });

  it("generates correct output for refs-and-edges fixture", async () => {
    const code = await generateFromSource(
      join(import.meta.dirname, "fixtures/refs-and-edges.json"),
    );
    expect(code).toMatchSnapshot();
  });

  it("refs-and-edges fixture is valid as .d.ts and passes tsc --noEmit", async () => {
    const code = await generateFromSource(
      join(import.meta.dirname, "fixtures/refs-and-edges.json"),
    );
    const tmp = "/tmp/openapi-dts-test-refs-and-edges.d.ts";
    await writeFile(tmp, code);
    try {
      const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
      await expect(
        run(tsc, ["--ignoreConfig", "--noEmit", "--strict", "--target", "esnext", tmp]),
      ).resolves.toBeUndefined();
    } finally {
      await unlink(tmp);
    }
  });

  it("generate(doc) accepts unresolved refs and resolves them", async () => {
    const { generate } = await import("../src/index");
    const doc = {
      components: {
        parameters: { P: { name: "p", in: "query", schema: { type: "string" } } },
      },
      paths: {
        "/x": {
          get: {
            parameters: [{ $ref: "#/components/parameters/P" }],
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    };
    const code = generate(doc);
    expect(code).toContain("query: { p?: string }");
  });

  it("generate(doc) injects discriminator literals end-to-end", async () => {
    const { generate } = await import("../src/index");
    const code = generate({
      components: {
        schemas: {
          Cat: { type: "object", properties: { purr: { type: "string" } }, required: ["purr"] },
          Dog: { type: "object", properties: { bark: { type: "string" } }, required: ["bark"] },
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
            discriminator: {
              propertyName: "type",
              mapping: { cat: "Cat", dog: "Dog" },
            },
          },
        },
      },
    });
    expect(code).toContain('type: "cat"');
    expect(code).toContain('type: "dog"');
    expect(code).toContain("export type Animal = Cat | Dog");
  });

  it("generate(doc) injects discriminator literals into allOf branches", async () => {
    const { generate } = await import("../src/index");
    const code = generate({
      components: {
        schemas: {
          BaseAnimal: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          Cat: {
            allOf: [
              { $ref: "#/components/schemas/BaseAnimal" },
              { type: "object", properties: { purr: { type: "string" } } },
            ],
          },
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }],
            discriminator: {
              propertyName: "type",
              mapping: { cat: "Cat" },
            },
          },
        },
      },
    });
    expect(code).toContain('export type Cat = BaseAnimal & {\n  purr?: string\n  type: "cat"\n}');
    expect(code).toContain("export type Animal = Cat");
  });

  it("generates correct output for discriminator fixture", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/discriminator.json"));
    expect(code).toMatchSnapshot();
  });

  it("discriminator fixture is valid as .d.ts and passes tsc --noEmit", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/discriminator.json"));
    const tmp = "/tmp/openapi-dts-test-discriminator.d.ts";
    await writeFile(tmp, code);
    try {
      const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
      await expect(
        run(tsc, ["--ignoreConfig", "--noEmit", "--strict", "--target", "esnext", tmp]),
      ).resolves.toBeUndefined();
    } finally {
      await unlink(tmp);
    }
  });
});
