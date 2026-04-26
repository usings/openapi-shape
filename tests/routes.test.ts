import { describe, expect, it } from "vitest";
import { generateRoutes } from "../src/routes";

const json = (schema: any) => ({ "200": { content: { "application/json": { schema } } } });
const jsonAt = (status: string, schema: any) => ({
  [status]: { content: { "application/json": { schema } } },
});
const okText = { "200": { content: { "text/plain": { schema: { type: "string" } } } } };

describe("generateRoutes", () => {
  it("generates a simple GET endpoint", () => {
    const result = generateRoutes({
      "/api/tasks": {
        get: { responses: json({ type: "array", items: { $ref: "#/components/schemas/Task" } }) },
      },
    });
    expect(result).toContain('"GET /api/tasks"');
    expect(result).toContain("params: void");
    expect(result).toContain("query: void");
    expect(result).toContain("body: void");
    expect(result).toContain("response: Task[]");
  });

  it("generates POST with request body", () => {
    const result = generateRoutes({
      "/api/tasks": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CreateTask" } },
            },
          },
          responses: jsonAt("201", {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          }),
        },
      },
    });
    expect(result).toContain('"POST /api/tasks"');
    expect(result).toContain("body: CreateTask");
    expect(result).toContain("response: {\n      id: number\n    }");
  });

  it("extracts path parameters", () => {
    const result = generateRoutes({
      "/api/tasks/{taskId}": {
        get: {
          parameters: [{ name: "taskId", in: "path", schema: { type: "string" } }],
          responses: json({ $ref: "#/components/schemas/Task" }),
        },
      },
    });
    expect(result).toContain("params: { taskId: string }");
  });

  it("extracts query parameters with optional", () => {
    const result = generateRoutes({
      "/api/tasks": {
        get: {
          parameters: [
            { name: "page", in: "query", schema: { type: "number" } },
            { name: "status", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: json({ type: "array", items: { type: "string" } }),
        },
      },
    });
    expect(result).toContain("query: { page?: number; status: string }");
  });

  it("uses unknown for missing response schema", () => {
    const result = generateRoutes({
      "/api/ping": { get: { responses: {} } },
    });
    expect(result).toContain("response: unknown");
  });

  it("picks first 2xx and ignores later ones", () => {
    const result = generateRoutes({
      "/api/tasks": {
        post: {
          responses: {
            ...jsonAt("200", { type: "string" }),
            ...jsonAt("201", { type: "number" }),
          },
        },
      },
    });
    expect(result).toContain("response: string");
  });

  it("falls back to 2XX wildcard response", () => {
    const result = generateRoutes({
      "/api/tasks": {
        delete: { responses: jsonAt("2XX", { type: "boolean" }) },
      },
    });
    expect(result).toContain("response: boolean");
  });

  it("generates multiple methods on same path", () => {
    const result = generateRoutes({
      "/api/tasks": {
        get: { responses: json({ type: "string" }) },
        post: { responses: json({ type: "number" }) },
      },
    });
    expect(result).toContain('"GET /api/tasks"');
    expect(result).toContain('"POST /api/tasks"');
  });

  it("handles path-level parameters", () => {
    const result = generateRoutes({
      "/api/tasks/{taskId}": {
        parameters: [{ name: "taskId", in: "path", schema: { type: "string" } }],
        get: { responses: json({ type: "string" }) },
      },
    });
    expect(result).toContain("params: { taskId: string }");
  });

  it("deduplicates path-level and operation-level params", () => {
    const result = generateRoutes({
      "/api/tasks/{taskId}": {
        parameters: [{ name: "taskId", in: "path", schema: { type: "string" } }],
        get: {
          parameters: [{ name: "taskId", in: "path", schema: { type: "integer" } }],
          responses: json({ type: "string" }),
        },
      },
    });
    // Should appear exactly once, operation-level wins
    expect(result.match(/taskId: string/g)).toHaveLength(1);
  });

  it("maps text/* response to string type", () => {
    const result = generateRoutes({
      "/api/health": { get: { responses: okText } },
    });
    expect(result).toContain("response: string");
  });

  it("maps binary response to Blob type", () => {
    const result = generateRoutes({
      "/files/{id}": {
        get: {
          parameters: [{ name: "id", in: "path", schema: { type: "string" } }],
          responses: {
            "200": {
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
          },
        },
      },
    });
    expect(result).toContain("response: Blob");
  });

  it("prefers json over text when both are available", () => {
    const result = generateRoutes({
      "/api/data": {
        get: {
          responses: {
            "200": {
              content: {
                "text/plain": { schema: { type: "string" } },
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "number" } },
                    required: ["id"],
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(result).toContain("response: {\n      id: number\n    }");
  });

  it("extracts body from multipart/form-data", () => {
    const result = generateRoutes({
      "/upload": {
        post: {
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: { file: { type: "string", format: "binary" } },
                  required: ["file"],
                },
              },
            },
          },
          responses: json({ type: "string" }),
        },
      },
    });
    expect(result).toContain("body: {\n      file: string\n    }");
  });

  it("resolves $ref parameters via generate(doc)", async () => {
    const { generate } = await import("../src/index");
    const code = generate({
      components: {
        parameters: {
          TaskId: { name: "taskId", in: "path", required: true, schema: { type: "string" } },
        },
      },
      paths: {
        "/api/tasks/{taskId}": {
          get: {
            parameters: [
              { $ref: "#/components/parameters/TaskId" },
              { name: "page", in: "query", schema: { type: "number" } },
            ],
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    });
    expect(code).toContain('"GET /api/tasks/{taskId}"');
    expect(code).toContain("params: { taskId: string }");
    expect(code).toContain("query: { page?: number }");
  });

  it("skips non-operation path-item keys (summary, description, x-* extensions)", () => {
    const result = generateRoutes({
      "/api/tasks": {
        summary: "Tasks resource",
        description: "Manage tasks",
        "x-internal-id": 42,
        $ref: "#/components/pathItems/Tasks",
        get: { responses: json({ type: "string" }) },
      },
    });
    expect(result.match(/"\w+ \//g)).toEqual(['"GET /']);
  });

  it("ignores header and cookie parameters", () => {
    const result = generateRoutes({
      "/api/tasks": {
        get: {
          parameters: [
            { name: "X-Token", in: "header", schema: { type: "string" } },
            { name: "session", in: "cookie", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "number" } },
          ],
          responses: json({ type: "string" }),
        },
      },
    });
    expect(result).toContain("params: void");
    expect(result).toContain("query: { page?: number }");
    expect(result).not.toContain("X-Token");
    expect(result).not.toContain("session");
  });

  it("emits JSDoc above route from operation summary and description", () => {
    const result = generateRoutes({
      "/api/tasks": {
        get: {
          summary: "List tasks",
          description: "Returns all tasks for the current user.",
          responses: json({ type: "array", items: { type: "string" } }),
        },
      },
    });
    expect(result).toContain(
      '  /**\n   * List tasks\n   *\n   * Returns all tasks for the current user.\n   */\n  "GET /api/tasks"',
    );
  });

  it("emits multi-line params with JSDoc when path param has description", () => {
    const result = generateRoutes({
      "/api/tasks/{taskId}": {
        get: {
          parameters: [
            {
              name: "taskId",
              in: "path",
              description: "Task identifier",
              schema: { type: "string" },
            },
          ],
          responses: json({ type: "string" }),
        },
      },
    });
    expect(result).toContain(
      "params: {\n      /** Task identifier */\n      taskId: string\n    }",
    );
  });

  it("emits multi-line query with JSDoc when any query param has description", () => {
    const result = generateRoutes({
      "/api/tasks": {
        get: {
          parameters: [
            { name: "page", in: "query", description: "Page number", schema: { type: "number" } },
            { name: "status", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: json({ type: "string" }),
        },
      },
    });
    expect(result).toContain(
      "query: {\n      /** Page number */\n      page?: number\n      status: string\n    }",
    );
  });

  it("keeps single-line query format when no descriptions are present", () => {
    const result = generateRoutes({
      "/api/tasks": {
        get: {
          parameters: [
            { name: "page", in: "query", schema: { type: "number" } },
            { name: "status", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: json({ type: "string" }),
        },
      },
    });
    expect(result).toContain("query: { page?: number; status: string }");
  });

  it("marks deprecated operations with @deprecated", () => {
    const result = generateRoutes({
      "/api/old": {
        get: { deprecated: true, responses: json({ type: "string" }) },
      },
    });
    expect(result).toContain('  /** @deprecated */\n  "GET /api/old"');
  });

  it("wraps everything in export interface API", () => {
    const result = generateRoutes({
      "/api/ping": { get: { responses: { "200": { description: "OK" } } } },
    });
    expect(result).toContain("export interface API {");
  });

  it("quotes path parameter names with illegal identifier chars", () => {
    const result = generateRoutes({
      "/api/pets/{pet-id}": {
        get: {
          parameters: [{ name: "pet-id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
        },
      },
    });
    expect(result).toContain('params: { "pet-id": string }');
  });

  it("quotes query parameter names with illegal identifier chars", () => {
    const result = generateRoutes({
      "/api/x": {
        get: {
          parameters: [{ name: "user-name", in: "query", schema: { type: "string" } }],
          responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
        },
      },
    });
    expect(result).toContain('query: { "user-name"?: string }');
  });

  it("emits body: T when requestBody.required is true", () => {
    const result = generateRoutes({
      "/x": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: {} } } },
          },
          responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
        },
      },
    });
    expect(result).toMatch(/body: \{[^?]*\}\s*\n/);
    expect(result).not.toContain("body?:");
  });

  it("emits body?: T when requestBody.required is missing", () => {
    const result = generateRoutes({
      "/x": {
        post: {
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: {} } } },
          },
          responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
        },
      },
    });
    expect(result).toContain("body?:");
  });

  it("prefers application/json request body schema over other content types", () => {
    const result = generateRoutes({
      "/x": {
        post: {
          requestBody: {
            required: true,
            content: {
              "text/plain": { schema: { type: "string" } },
              "application/json": { schema: { $ref: "#/components/schemas/CreateTask" } },
            },
          },
          responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
        },
      },
    });
    expect(result).toContain("body: CreateTask");
  });

  it("resolves pathItem $ref via generate(doc)", async () => {
    const { generate } = await import("../src/index");
    const code = generate({
      components: {
        pathItems: {
          TaskById: {
            parameters: [
              { name: "taskId", in: "path", required: true, schema: { type: "string" } },
            ],
            get: {
              responses: {
                "200": { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      },
      paths: {
        "/tasks/{taskId}": { $ref: "#/components/pathItems/TaskById" },
      },
    });
    expect(code).toContain('"GET /tasks/{taskId}"');
    expect(code).toContain("params: { taskId: string }");
  });

  it("emits body?: T when requestBody.required is explicitly false", () => {
    const result = generateRoutes({
      "/x": {
        patch: {
          requestBody: {
            required: false,
            content: { "application/json": { schema: { type: "object", properties: {} } } },
          },
          responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
        },
      },
    });
    expect(result).toContain("body?:");
  });

  it("returns void for a 204-only response", () => {
    const result = generateRoutes({
      "/x": {
        delete: { responses: { "204": { description: "No Content" } } },
      },
    });
    expect(result).toContain("response: void");
  });

  it("returns void for a 200 with no content", () => {
    const result = generateRoutes({
      "/x": {
        get: { responses: { "200": { description: "OK" } } },
      },
    });
    expect(result).toContain("response: void");
  });

  it("prefers a 2xx with content schema over an empty 2xx", () => {
    const result = generateRoutes({
      "/x": {
        get: {
          responses: {
            "200": { content: { "application/json": { schema: { type: "string" } } } },
            "204": { description: "No Content" },
          },
        },
      },
    });
    expect(result).toContain("response: string");
    expect(result).not.toContain("response: void");
  });

  it("returns unknown when no 2xx exists", () => {
    const result = generateRoutes({
      "/x": {
        get: { responses: { "500": { description: "Server Error" } } },
      },
    });
    expect(result).toContain("response: unknown");
  });
});
