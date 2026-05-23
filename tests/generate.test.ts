import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "../src/index";
import { expectPassesTsc } from "./_helpers/tsc";

describe("generate (integration)", () => {
  it("generates correct output for petstore fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/petstore.json"));
    expect(code).toMatchSnapshot();
  });

  it("generates correct output for edge-cases fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/edge-cases.json"));
    expect(code).toMatchSnapshot();
  });

  it("generated code is valid as .d.ts and passes tsc --noEmit", async () => {
    const [petstoreCode, edgeCasesCode] = await Promise.all([
      generate(join(import.meta.dirname, "fixtures/petstore.json")),
      generate(join(import.meta.dirname, "fixtures/edge-cases.json")),
    ]);
    await expectPassesTsc([petstoreCode, edgeCasesCode]);
  });

  it("generates correct output for refs-and-edges fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/refs-and-edges.json"));
    expect(code).toMatchSnapshot();
  });

  it("refs-and-edges fixture is valid as .d.ts and passes tsc --noEmit", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/refs-and-edges.json"));
    await expectPassesTsc([code]);
  });

  it("generate(doc) accepts unresolved refs and resolves them", () => {
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

  it("generate(doc) injects discriminator literals end-to-end", () => {
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

  it("generate(doc) injects discriminator literals into allOf branches", () => {
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
    expect(code).toContain(
      'export type Cat = BaseAnimal & {\n    purr?: string\n    type: "cat"\n  }',
    );
    expect(code).toContain("export type Animal = Cat");
  });

  it("generates correct output for discriminator fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/discriminator.json"));
    expect(code).toMatchSnapshot();
  });

  it("discriminator fixture is valid as .d.ts and passes tsc --noEmit", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/discriminator.json"));
    await expectPassesTsc([code]);
  });

  it("generates correct output for 3.0.x fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/3.0.x.json"));
    expect(code).toMatchSnapshot();
  });

  it("generates correct output for 3.1.x fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/3.1.x.json"));
    expect(code).toMatchSnapshot();
  });

  it("3.0.x and 3.1.x fixtures are valid as .d.ts and pass tsc --noEmit", async () => {
    const [v30, v31] = await Promise.all([
      generate(join(import.meta.dirname, "fixtures/3.0.x.json")),
      generate(join(import.meta.dirname, "fixtures/3.1.x.json")),
    ]);
    await expectPassesTsc([v30, v31]);
  });

  it("formats maps date-time to Date in petstore", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/petstore.json"), {
      formats: { "date-time": "Date" },
    });
    expect(code).toMatchSnapshot();
  });

  it("headers: false (default) omits header parameters from endpoint type", () => {
    const code = generate({
      paths: {
        "/x": {
          get: {
            parameters: [
              { name: "X-API-Key", in: "header", required: true, schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(code).not.toContain("headers:");
    expect(code).not.toContain("X-API-Key");
  });

  it("headers: true emits typed headers field per endpoint", () => {
    const code = generate(
      {
        paths: {
          "/secure": {
            get: {
              parameters: [
                { name: "X-API-Key", in: "header", required: true, schema: { type: "string" } },
                { name: "X-Trace-Id", in: "header", schema: { type: "string" } },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
          "/public": {
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      },
      { headers: true },
    );
    expect(code).toContain('headers: { "X-API-Key": string; "X-Trace-Id"?: string }');
    expect(code).toContain("headers: void");
  });

  it("response field is a status-keyed map of every declared response", () => {
    const code = generate({
      paths: {
        "/x": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
              "400": { content: { "application/json": { schema: { type: "string" } } } },
              default: { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    });
    expect(code).toContain('response: { "200": string; "400": string; "default": string }');
  });
});
