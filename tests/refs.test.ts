import { describe, expect, it } from "vitest";
import { resolveRefs } from "../src/refs";

describe("resolveRefs", () => {
  describe("primitives", () => {
    it("throws on missing ref target", () => {
      const doc = {
        paths: {
          "/x": {
            get: { parameters: [{ $ref: "#/components/parameters/Missing" }], responses: {} },
          },
        },
      };
      expect(() => resolveRefs(doc)).toThrow(/ref not found/);
    });

    it("throws on circular ref chain with full chain in message", () => {
      const doc = {
        components: {
          parameters: {
            A: { $ref: "#/components/parameters/B" },
            B: { $ref: "#/components/parameters/A" },
          },
        },
        paths: {
          "/x": { get: { parameters: [{ $ref: "#/components/parameters/A" }], responses: {} } },
        },
      };
      expect(() => resolveRefs(doc)).toThrow(/circular/);
      expect(() => resolveRefs(doc)).toThrow(/A.*B.*A/);
    });
  });

  describe("inlining", () => {
    it("inlines path-level parameter $ref", () => {
      const doc = {
        components: {
          parameters: {
            TaskId: { name: "taskId", in: "path", required: true, schema: { type: "string" } },
          },
        },
        paths: {
          "/tasks/{taskId}": {
            parameters: [{ $ref: "#/components/parameters/TaskId" }],
            get: { responses: {} },
          },
        },
      };
      const out = resolveRefs(doc);
      expect(out.paths["/tasks/{taskId}"].parameters[0]).toEqual({
        name: "taskId",
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    });

    it("inlines operation-level parameter $ref", () => {
      const doc = {
        components: {
          parameters: { Page: { name: "page", in: "query", schema: { type: "integer" } } },
        },
        paths: {
          "/x": {
            get: {
              parameters: [{ $ref: "#/components/parameters/Page" }],
              responses: {},
            },
          },
        },
      };
      const out = resolveRefs(doc);
      expect(out.paths["/x"].get.parameters[0].name).toBe("page");
    });

    it("inlines requestBody $ref", () => {
      const doc = {
        components: {
          requestBodies: {
            TaskCreate: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Task" } } },
            },
          },
        },
        paths: {
          "/x": {
            post: {
              requestBody: { $ref: "#/components/requestBodies/TaskCreate" },
              responses: {},
            },
          },
        },
      };
      const out = resolveRefs(doc);
      expect(out.paths["/x"].post.requestBody).toEqual({
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/Task" } } },
      });
    });

    it("inlines response $ref", () => {
      const doc = {
        components: {
          responses: {
            TaskOk: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Task" } } },
            },
          },
        },
        paths: {
          "/x": {
            get: { responses: { "200": { $ref: "#/components/responses/TaskOk" } } },
          },
        },
      };
      const out = resolveRefs(doc);
      expect(out.paths["/x"].get.responses["200"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Task",
      });
    });

    it("inlines pathItem $ref", () => {
      const doc = {
        components: {
          pathItems: {
            TaskById: {
              parameters: [
                { name: "taskId", in: "path", required: true, schema: { type: "string" } },
              ],
              get: { responses: { "200": { description: "OK" } } },
            },
          },
        },
        paths: {
          "/tasks/{taskId}": { $ref: "#/components/pathItems/TaskById" },
        },
      };
      const out = resolveRefs(doc);
      expect(out.paths["/tasks/{taskId}"].parameters[0].name).toBe("taskId");
      expect(out.paths["/tasks/{taskId}"].get.responses["200"].description).toBe("OK");
    });

    it("follows a multi-step parameter ref chain", () => {
      const doc = {
        components: {
          parameters: {
            Outer: { $ref: "#/components/parameters/Inner" },
            Inner: { name: "x", in: "query", schema: { type: "string" } },
          },
        },
        paths: {
          "/x": { get: { parameters: [{ $ref: "#/components/parameters/Outer" }], responses: {} } },
        },
      };
      const out = resolveRefs(doc);
      expect(out.paths["/x"].get.parameters[0].name).toBe("x");
    });

    it("does NOT inline schema $ref (preserved for codegen)", () => {
      const doc = {
        components: { schemas: { Task: { type: "object" } } },
        paths: {
          "/x": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Task" } },
                  },
                },
              },
            },
          },
        },
      };
      const out = resolveRefs(doc);
      const schemaRef = out.paths["/x"].get.responses["200"].content["application/json"].schema;
      expect(schemaRef).toEqual({ $ref: "#/components/schemas/Task" });
    });

    it("is idempotent (calling twice yields same shape)", () => {
      const doc = {
        components: {
          parameters: { P: { name: "p", in: "query", schema: { type: "string" } } },
        },
        paths: {
          "/x": { get: { parameters: [{ $ref: "#/components/parameters/P" }], responses: {} } },
        },
      };
      const once = resolveRefs(doc);
      const twice = resolveRefs(once);
      expect(twice.paths["/x"].get.parameters[0].name).toBe("p");
    });

    it("throws when parameter ref points outside components.parameters", () => {
      const doc = {
        components: { schemas: { S: { type: "object" } } },
        paths: {
          "/x": {
            get: { parameters: [{ $ref: "#/components/schemas/S" }], responses: {} },
          },
        },
      };
      expect(() => resolveRefs(doc)).toThrow(/expected components\.parameters/);
    });

    it("throws when requestBody ref points outside components.requestBodies", () => {
      const doc = {
        components: { schemas: { S: { type: "object" } } },
        paths: {
          "/x": {
            post: { requestBody: { $ref: "#/components/schemas/S" }, responses: {} },
          },
        },
      };
      expect(() => resolveRefs(doc)).toThrow(/expected components\.requestBodies/);
    });

    it("throws when response ref points outside components.responses", () => {
      const doc = {
        components: { schemas: { S: { type: "object" } } },
        paths: {
          "/x": {
            get: { responses: { "200": { $ref: "#/components/schemas/S" } } },
          },
        },
      };
      expect(() => resolveRefs(doc)).toThrow(/expected components\.responses/);
    });

    it("throws when pathItem ref points outside components.pathItems", () => {
      const doc = {
        components: { schemas: { S: { type: "object" } } },
        paths: {
          "/x": { $ref: "#/components/schemas/S" },
        },
      };
      expect(() => resolveRefs(doc)).toThrow(/expected components\.pathItems/);
    });
  });
});
