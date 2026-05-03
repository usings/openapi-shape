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

async function expectPassesTsc(codes: string[]): Promise<void> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpFiles = codes.map((_, i) => `/tmp/openapi-dts-test-${stamp}-${i}.d.ts`);
  await Promise.all(codes.map((code, i) => writeFile(tmpFiles[i], code)));
  try {
    const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
    await expect(
      run(tsc, ["--ignoreConfig", "--noEmit", "--strict", "--target", "esnext", ...tmpFiles]),
    ).resolves.toBeUndefined();
  } finally {
    await Promise.all(tmpFiles.map((tmp) => unlink(tmp)));
  }
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
    const [petstoreCode, edgeCasesCode] = await Promise.all([
      generateFromSource(join(import.meta.dirname, "fixtures/petstore.json")),
      generateFromSource(join(import.meta.dirname, "fixtures/edge-cases.json")),
    ]);
    await expectPassesTsc([petstoreCode, edgeCasesCode]);
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
    await expectPassesTsc([code]);
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

  it("emits a header with title, version, and description from info", async () => {
    const { generate } = await import("../src/index");
    const code = generate({
      info: { title: "My API", version: "2.3.4", description: "Multi-line\ndescription." },
    });
    expect(code.startsWith("/**\n")).toBe(true);
    expect(code).toContain(" * My API\n");
    expect(code).toContain(" * @version 2.3.4\n");
    expect(code).toContain(" * @description Multi-line\n * description.\n");
    expect(code).toContain(" * @generated by openapi-shape.\n");
  });

  it("emits a header even when info is missing", async () => {
    const { generate } = await import("../src/index");
    const code = generate({});
    expect(code.startsWith("/**\n")).toBe(true);
    expect(code).toContain(" * @generated by openapi-shape.\n");
  });

  it("generates correct output for discriminator fixture", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/discriminator.json"));
    expect(code).toMatchSnapshot();
  });

  it("discriminator fixture is valid as .d.ts and passes tsc --noEmit", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/discriminator.json"));
    await expectPassesTsc([code]);
  });

  it("generates correct output for 3.0.x fixture", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/3.0.x.json"));
    expect(code).toMatchSnapshot();
  });

  it("generates correct output for 3.1.x fixture", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/3.1.x.json"));
    expect(code).toMatchSnapshot();
  });

  it("3.0.x and 3.1.x fixtures are valid as .d.ts and pass tsc --noEmit", async () => {
    const [v30, v31] = await Promise.all([
      generateFromSource(join(import.meta.dirname, "fixtures/3.0.x.json")),
      generateFromSource(join(import.meta.dirname, "fixtures/3.1.x.json")),
    ]);
    await expectPassesTsc([v30, v31]);
  });

  it("formats maps date-time to Date in petstore", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/petstore.json"), {
      formats: { "date-time": "Date" },
    });
    expect(code).toMatchSnapshot();
  });

  it("errors: true adds errors field", async () => {
    const { generate } = await import("../src/index");
    const code = generate(
      {
        paths: {
          "/x": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: { type: "string" } } } },
                "400": { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      },
      { errors: true },
    );
    expect(code).toContain('errors: { "400": string }');
  });

  it("header: false omits the JSDoc header", async () => {
    const code = await generateFromSource(join(import.meta.dirname, "fixtures/petstore.json"), {
      header: false,
    });
    expect(code.startsWith("/**\n")).toBe(false);
  });
});
