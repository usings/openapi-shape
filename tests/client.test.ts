import { describe, expect, it, vi } from "vitest";
import { createClient, type Adapter, type Client } from "../src/client";

interface TestAPI {
  "GET /pets": {
    params: void;
    query: { limit?: number };
    body: void;
    response: { id: number; name: string }[];
  };
  "POST /pets": {
    params: void;
    query: void;
    body: { name: string };
    response: { id: number };
  };
  "GET /pets/{petId}": {
    params: { petId: string };
    query: void;
    body: void;
    response: { id: number; name: string };
  };
  "DELETE /pets/{petId}/tags/{tagId}": {
    params: { petId: string; tagId: string };
    query: void;
    body: void;
    response: void;
  };
  "GET /search": {
    params: void;
    query: { q: string; page?: number };
    body: void;
    response: string[];
  };
  "POST /upload": {
    params: void;
    query: void;
    body: { file: Blob; name: string };
    response: { url: string };
  };
}

describe("createClient", () => {
  it("calls adapter with correct method and url", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter);

    await api("GET /pets");

    expect(adapter).toHaveBeenCalledWith({
      method: "GET",
      url: "/pets",
      body: undefined,
      headers: {},
    });
  });

  it("throws when endpoint key does not include a path", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<{
      GET: {
        params: void;
        query: void;
        body: void;
        response: void;
      };
    }>(adapter);

    await expect(api("GET")).rejects.toThrow("Invalid endpoint: GET");
    expect(adapter).not.toHaveBeenCalled();
  });

  it("appends query parameters to url", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter);

    await api("GET /pets", { query: { limit: 10 } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/pets?limit=10");
  });

  it("appends array query parameters as repeated keys", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter);

    await api("GET /search", { query: { q: "cat", tags: ["small", "short hair"] } as any });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/search?q=cat&tags=small&tags=short+hair");
  });

  it("supports custom query serialization", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter, {
      serializeQuery(query) {
        return Object.entries(query)
          .filter(([, value]) => value != null)
          .map(([name, value]) => {
            const serializedValue = Array.isArray(value) ? value.join(",") : String(value);
            return `${encodeURIComponent(name)}=${encodeURIComponent(serializedValue)}`;
          })
          .join("&");
      },
    });

    await api("GET /search", { query: { q: "cat", tags: ["small", "short hair"] } as any });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/search?q=cat&tags=small%2Cshort%20hair");
  });

  it("allows custom query serializer to return a leading question mark", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter, {
      serializeQuery: () => "?q=cat",
    });

    await api("GET /search", { query: { q: "ignored" } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/search?q=cat");
  });

  it("replaces path parameters", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1, name: "Buddy" });
    const api = createClient<TestAPI>(adapter);

    await api("GET /pets/{petId}", { params: { petId: "123" } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/pets/123");
  });

  it("replaces multiple path parameters", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<TestAPI>(adapter);

    await api("DELETE /pets/{petId}/tags/{tagId}", {
      params: { petId: "1", tagId: "2" },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/pets/1/tags/2");
  });

  it("replaces repeated path parameter placeholders", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<{
      "GET /items/{id}/related/{id}": {
        params: { id: string };
        query: void;
        body: void;
        response: void;
      };
    }>(adapter);

    await api("GET /items/{id}/related/{id}", { params: { id: "x/y" } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/items/x%2Fy/related/x%2Fy");
  });

  it("stringifies non-string path parameter values before encoding", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<{
      "GET /pets/{petId}": {
        params: { petId: number };
        query: void;
        body: void;
        response: void;
      };
    }>(adapter);

    await api("GET /pets/{petId}", { params: { petId: 123 } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/pets/123");
  });

  it("throws when a path parameter remains unresolved", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<{
      "GET /pets/{petId}/tags/{tagId}": {
        params: { petId: string };
        query: void;
        body: void;
        response: void;
      };
    }>(adapter);

    await expect(api("GET /pets/{petId}/tags/{tagId}", { params: { petId: "1" } })).rejects.toThrow(
      "Missing path param: tagId",
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it("throws when a path parameter value is nullish", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<TestAPI>(adapter);

    await expect(api("GET /pets/{petId}", { params: { petId: undefined as any } })).rejects.toThrow(
      "Missing path param: petId",
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it("serializes plain object body as JSON", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1 });
    const api = createClient<TestAPI>(adapter);

    await api("POST /pets", { body: { name: "Buddy" } });

    const call = adapter.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.body).toBe('{"name":"Buddy"}');
    expect(call.headers).toEqual({ "content-type": "application/json" });
  });

  it("supports custom body serialization", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1 });
    const api = createClient<TestAPI>(adapter, {
      serializeBody(body) {
        return {
          body: String((body as { name: string }).name),
          headers: { "Content-Type": "text/plain" },
        };
      },
    });

    await api("POST /pets", { body: { name: "Buddy" } });

    const call = adapter.mock.calls[0][0];
    expect(call.body).toBe("Buddy");
    expect(call.headers).toEqual({ "content-type": "text/plain" });
  });

  it("merges per-call headers on top of custom body headers", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1 });
    const api = createClient<TestAPI>(adapter, {
      serializeBody() {
        return {
          body: "Buddy",
          headers: { "Content-Type": "text/plain", "X-Body": "1" },
        };
      },
    });

    await api("POST /pets", {
      body: { name: "Buddy" },
      headers: { "Content-Type": "application/custom" },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.headers).toEqual({
      "content-type": "application/custom",
      "x-body": "1",
    });
  });

  it.each([
    [
      "FormData",
      () => {
        const form = new FormData();
        form.append("name", "test");
        return form;
      },
    ],
    ["URLSearchParams", () => new URLSearchParams({ name: "Buddy" })],
    ["Blob", () => new Blob(["hello"], { type: "text/plain" })],
    ["ArrayBuffer", () => new ArrayBuffer(4)],
    ["Uint8Array", () => new Uint8Array([1, 2, 3])],
    [
      "ReadableStream",
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
    ],
  ])("passes %s body through without setting Content-Type", async (_name, makeBody) => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ url: "https://..." });
    const api = createClient<TestAPI>(adapter);

    const body = makeBody();
    await api("POST /upload", { body });

    const call = adapter.mock.calls[0][0];
    expect(call.body).toBe(body);
    expect(call.headers).toEqual({});
  });

  it("passes string body through with content-type: text/plain", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({});
    const api = createClient<{
      "POST /raw": {
        params: void;
        query: void;
        body: string;
        response: void;
      };
    }>(adapter);

    await api("POST /raw", { body: "hello world" });

    const call = adapter.mock.calls[0][0];
    expect(call.body).toBe("hello world");
    expect(call.headers).toEqual({ "content-type": "text/plain" });
  });

  it("omits body and headers for no body", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter);

    await api("GET /pets");

    const call = adapter.mock.calls[0][0];
    expect(call.body).toBeUndefined();
    expect(call.headers).toEqual({});
  });

  it("skips undefined query params", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter);

    await api("GET /search", { query: { q: "hello", page: undefined as any } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/search?q=hello");
  });

  it("encodes path parameter values", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1, name: "test" });
    const api = createClient<TestAPI>(adapter);

    await api("GET /pets/{petId}", { params: { petId: "a/b" } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/pets/a%2Fb");
  });

  it("returns adapter result", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([{ id: 1, name: "Buddy" }]);
    const api = createClient<TestAPI>(adapter);

    const result = await api("GET /pets");
    expect(result).toEqual([{ id: 1, name: "Buddy" }]);
  });

  it("supports baseURL option", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter, { baseURL: "https://api.example.com" });

    await api("GET /pets");

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("https://api.example.com/pets");
  });

  it("strips trailing slash from baseURL to avoid double slashes", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter, { baseURL: "https://api.example.com/" });

    await api("GET /pets");

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("https://api.example.com/pets");
  });

  it("strips multiple trailing slashes from baseURL", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter, { baseURL: "https://api.example.com///" });

    await api("GET /pets");

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("https://api.example.com/pets");
  });

  it("bypasses baseURL when endpoint path is an absolute URL", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<{
      "GET https://other.example.com/hook": {
        params: void;
        query: { token: string };
        body: void;
        response: void;
      };
    }>(adapter, { baseURL: "https://api.example.com" });

    await api("GET https://other.example.com/hook", { query: { token: "x" } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("https://other.example.com/hook?token=x");
  });

  it("keeps falsy but defined query values (0, false, empty string)", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter);

    await api("GET /search", {
      query: { q: "", page: 0, extra: false as any } as any,
    });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/search?q=&page=0&extra=false");
  });

  it("appends query parameters after an existing query string", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<{
      "GET /search?sort=name": {
        params: void;
        query: { q: string };
        body: void;
        response: string[];
      };
    }>(adapter);

    await api("GET /search?sort=name", { query: { q: "cat" } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/search?sort=name&q=cat");
  });

  it("keeps url hash after appended query parameters", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<{
      "GET /search#items": {
        params: void;
        query: { q: string };
        body: void;
        response: string[];
      };
    }>(adapter);

    await api("GET /search#items", { query: { q: "cat" } });

    const call = adapter.mock.calls[0][0];
    expect(call.url).toBe("/search?q=cat#items");
  });

  it("merges per-call headers on top of body Content-Type", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({});
    const api = createClient<TestAPI>(adapter);

    await api("POST /pets", {
      body: { name: "x" },
      headers: { "X-Trace-Id": "abc" },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.headers).toEqual({
      "content-type": "application/json",
      "x-trace-id": "abc",
    });
  });

  it("per-call header overrides the auto-set content-type case-insensitively", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({});
    const api = createClient<TestAPI>(adapter);

    await api("POST /pets", {
      body: { name: "x" },
      headers: { "content-type": "text/plain" },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.headers).toEqual({ "content-type": "text/plain" });
  });

  it("merges default headers before body and per-call headers", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({});
    const api = createClient<TestAPI>(adapter, {
      headers: {
        "Content-Type": "text/plain",
        "X-App": "docs",
        "X-Trace-Id": "default",
      },
    });

    await api("POST /pets", {
      body: { name: "x" },
      headers: { "X-Trace-Id": "call" },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.headers).toEqual({
      "content-type": "application/json",
      "x-app": "docs",
      "x-trace-id": "call",
    });
  });

  it("trims header names and skips empty header names", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({});
    const api = createClient<TestAPI>(adapter, {
      headers: {
        " X-App ": "docs",
        "": "empty",
        "   ": "blank",
      },
    });

    await api("GET /pets", {
      headers: { " X-Trace-Id ": "abc" },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.headers).toEqual({
      "x-app": "docs",
      "x-trace-id": "abc",
    });
  });

  it("throws when JSON body serialization returns undefined", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({});
    const api = createClient<TestAPI>(adapter);

    await expect(api("POST /pets", { body: (() => undefined) as any })).rejects.toThrow(
      "Request body cannot be serialized as JSON",
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it("throws with context when JSON body serialization fails", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({});
    const api = createClient<TestAPI>(adapter);
    const body: Record<string, unknown> = {};
    body.self = body;

    await expect(api("POST /pets", { body: body as any })).rejects.toThrow(
      "Failed to serialize request body as JSON",
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it("passes per-call options through to the adapter", async () => {
    type CustomOptions = { timeout?: number; tag?: string };
    const adapter = vi.fn<Adapter<CustomOptions>>().mockResolvedValue([]);
    const api = createClient<TestAPI, CustomOptions>(adapter);

    await api("GET /pets", {
      query: { limit: 5 },
      options: { timeout: 5000, tag: "v1" },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.options).toEqual({ timeout: 5000, tag: "v1" });
  });

  it("passes default options through to the adapter", async () => {
    type CustomOptions = { timeout?: number; tag?: string };
    const adapter = vi.fn<Adapter<CustomOptions>>().mockResolvedValue([]);
    const api = createClient<TestAPI, CustomOptions>(adapter, {
      options: { timeout: 5000, tag: "default" },
    });

    await api("GET /pets");

    const call = adapter.mock.calls[0][0];
    expect(call.options).toEqual({ timeout: 5000, tag: "default" });
  });

  it("merges per-call options on top of default options", async () => {
    type CustomOptions = { timeout?: number; tag?: string; retry?: number };
    const adapter = vi.fn<Adapter<CustomOptions>>().mockResolvedValue([]);
    const api = createClient<TestAPI, CustomOptions>(adapter, {
      options: { timeout: 5000, tag: "default" },
    });

    await api("GET /pets", {
      options: { tag: "call", retry: 2 },
    });

    const call = adapter.mock.calls[0][0];
    expect(call.options).toEqual({ timeout: 5000, tag: "call", retry: 2 });
  });

  it("uses per-call options when options are not objects", async () => {
    const adapter = vi.fn<Adapter<string>>().mockResolvedValue([]);
    const api = createClient<TestAPI, string>(adapter, { options: "default" });

    await api("GET /pets", { options: "call" });

    const call = adapter.mock.calls[0][0];
    expect(call.options).toBe("call");
  });

  it("options is undefined when caller omits it", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api = createClient<TestAPI>(adapter);

    await api("GET /pets");

    const call = adapter.mock.calls[0][0];
    expect(call.options).toBeUndefined();
  });

  it("can be assigned to exported Client type", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([]);
    const api: Client<TestAPI> = createClient<TestAPI>(adapter);

    await api("GET /pets");

    expect(adapter).toHaveBeenCalledOnce();
  });
});

describe("createClient body optionality (type-level)", () => {
  interface OptAPI {
    "PATCH /x": {
      params: void;
      query: void;
      body?: { name: string };
      response: void;
    };
  }
  interface ReqAPI {
    "POST /x": {
      params: void;
      query: void;
      body: { name: string };
      response: void;
    };
  }
  interface NoBodyAPI {
    "GET /x": {
      params: void;
      query: void;
      body: void;
      response: void;
    };
  }

  it("optional body: caller may omit body entirely", async () => {
    const adapter: Adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<OptAPI>(adapter);
    await api("PATCH /x");
    await api("PATCH /x", {});
    await api("PATCH /x", { body: { name: "x" } });
    expect(adapter).toBeDefined();
  });

  it("required body: caller must supply body", async () => {
    const adapter: Adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<ReqAPI>(adapter);
    await api("POST /x", { body: { name: "x" } });
    // @ts-expect-error: body is required
    await api("POST /x");
    // @ts-expect-error: body is required
    await api("POST /x", {});
    expect(adapter).toBeDefined();
  });

  it("body: void: caller must not pass body", async () => {
    const adapter: Adapter = vi.fn<Adapter>().mockResolvedValue(undefined);
    const api = createClient<NoBodyAPI>(adapter);
    await api("GET /x");
    // @ts-expect-error: body is not allowed
    await api("GET /x", { body: { foo: 1 } });
    expect(adapter).toBeDefined();
  });
});
