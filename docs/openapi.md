# OpenAPI support and limits

`openapi-shape` projects an API description into TypeScript types and request serialization metadata. It supports OpenAPI 3.0.x, 3.1.x, and 3.2.x. Successful generation is not full specification validation, and the client does not validate payloads against schemas. Use the original description with a validator when runtime validation is required.

The rules below define the projection. Some widen what TypeScript accepts, while others deliberately narrow it; they do not change the API's source contract. Incorrect output within the documented rules is a generator defect.

## Input and versions

JSON and YAML documents can be loaded from files, URLs, or parsed objects; see [generation](./generation.md). Each OpenAPI document uses its own declared version. Schema-only documents inherit the entry version. Missing/unsupported entry versions and Swagger 2.0 are rejected.

The generator applies its documented JSON Schema 2020-12 keyword projections. Explicit `$schema` and `jsonSchemaDialect` declarations must identify 2020-12 or a supported OpenAPI 3.1/3.2 base dialect; other dialects fail generation. It also accepts some later keywords in earlier OpenAPI versions; see [cross-version rules](#cross-version-rules).

## Schema projection

| Input                                         | TypeScript projection                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`, annotations only                | `unknown`                                                                                                        |
| `false`, empty `enum`, `not: {}`, `not: true` | `never`                                                                                                          |
| `type`, including type arrays                 | Primitive, array, object, or union; `integer` uses `number`.                                                     |
| `const`, `enum`                               | Literal types, including objects and arrays; values incompatible with `type` are dropped.                        |
| `items`, `prefixItems`                        | Array or tuple; elements beyond `minItems` are optional, and `items: false` closes a tuple.                      |
| `properties`, `required`                      | Required/optional properties; undeclared required names use pattern/additional property types or `unknown`.      |
| `additionalProperties`, `patternProperties`   | An index signature widened to admit named properties.                                                            |
| `allOf`                                       | Intersection; plain object members can merge.                                                                    |
| `anyOf`, `oneOf`                              | Union; exclusivity is not enforced.                                                                              |
| `if`/`then`/`else`                            | With `if` and `else`, the union of `if & then` and `else`; no negation of `if` is inferred.                      |
| `$ref`                                        | Target intersected with sibling keywords.                                                                        |
| `$dynamicRef`                                 | Static resolution as `$ref`, with a precision warning.                                                           |
| `nullable: true`                              | Adds `null`, including beside references and compositions.                                                       |
| `format` and validation annotations           | JSDoc where applicable; generally no change to the type. Binary annotations have transport-specific projections. |

Numeric/string constraints, `uniqueItems`, `contains`, dependencies, `propertyNames`, and `unevaluated*` are not enforced by the types. `not` is ignored except for the two impossible schemas above. Conditionals without `else` do not constrain the type. `additionalProperties: false` does not make an exact/closed TypeScript object, and pattern-property regexes do not restrict index-signature keys.

Object keywords such as `properties` and `required` imply an object; array keywords imply an array. JSON Schema can also permit other value types when `type` is absent. An explicit different type takes precedence in an intersection, subject to [complexity limits](#precision-and-complexity-limits).

Objects with named properties do not gain an index signature unless declared, so TypeScript excess-property checking can reject extra fields in literals. Objects without named properties default to an `unknown` index signature. Names such as `toString` or `constructor` can also interact with TypeScript's `Object.prototype` checks.

### Discriminators

For `oneOf`/`anyOf`, referenced alternatives are intersected with mapped discriminator strings, or their component names when unmapped. An `allOf` descendant of a discriminated component receives its values and those of its descendants. Mapping targets containing `/`, `#`, or a URI scheme are URI references; other targets are component names.

Existing string literals constrain the narrowing. Disjoint mappings leave the schema unchanged and warn; non-object/non-string branches that cannot be narrowed warn too. Inline alternatives and the OpenAPI 3.2 `defaultMapping` target are not narrowed. Discriminator assumptions may exclude values the schemas alone permit.

Required `readOnly`/`writeOnly` fields have directional requiredness; see [schemas and directional types](./contract.md#schemas-and-directional-types).

## Media projections

An operation retains content by declared media type. The client's request and decoded result types then reflect how that representation is sent or read:

| Media                               | Structured request                                 | Decoded response       |
| ----------------------------------- | -------------------------------------------------- | ---------------------- |
| JSON: `…/json`, `…+json`            | JSON schema projection                             | JSON schema projection |
| `application/x-www-form-urlencoded` | Form object or encoded string                      | `Blob`                 |
| `multipart/form-data`               | Object with file-part projections                  | `Blob`                 |
| Other `text/*`                      | String, narrowed to string literals where possible | Same string projection |
| Binary, XML, YAML, other multipart  | Ready body or encoded string                       | `Blob`                 |

Without a JSON schema, values are `unknown`. `application/*` and `*/*` permit JSON encoding and add `Blob` to decoded types; `*/*` also allows text. `text/*` may include `text/json`, so its decoded type can be `unknown` unless narrowed to strings. Ready bodies bypass structured encoding; see [serialization](./serialization.md).

A binary annotation is a non-literal `type: string` with `format: binary`, or a binary `contentMediaType` without `contentEncoding`. `type: file` is treated similarly. JSON schemas, parameters, and form text keep strings; multipart file parts use `Blob`. Nested JSON parts retain string projections, and explicitly styled parts use text projections. Binary response media use `Blob` regardless of schema annotations. No base64 conversion is inferred; `format: byte` stays text.

### Sequence projections

| Sequence schema           | Complete content type | JSON stream item |
| ------------------------- | --------------------- | ---------------- |
| `itemSchema: T`           | `T[]`                 | `T`              |
| `schema` describing `T[]` | `T[]`                 | `T`              |
| Neither                   | `unknown[]`           | `unknown`        |

`itemSchema` wins over `schema` and describes one record, even when that record is an array. A scalar complete-content schema is not implicitly wrapped and yields an unknown JSON stream item. These rules also apply through references and to `…+json-seq` media that the client does not decode automatically.

For SSE, the item schema narrows standard `StreamMessage` fields only: text `data`, `event`, `id`, and optional numeric `retry`. Extra properties are not synthesized. `contentSchema` and `contentMediaType` do not JSON-decode `data`. Without an item schema, items use `StreamMessage`. See [streaming](./streaming.md) for media selection and parser behavior.

## Endpoints

- Fixed methods are `get`, `put`, `post`, `delete`, `options`, `head`, `patch`, and `trace`, plus `query` and `additionalOperations`. Generated descriptions retain all methods. The client excludes Fetch-forbidden `CONNECT`, `TRACE`, and `TRACK`; custom method keys retain their spelling.
- Path Item and operation parameters merge by name and location; operation parameters win. Header names are case-insensitive. A parameter uses `schema` or its single `content` entry.
- A `querystring` parameter replaces ordinary query parameters, with a warning. Only the first effective whole-query parameter is used; ignored schemas are not loaded or compiled.
- Header parameters `Accept`, `Content-Type`, and `Authorization`, and response headers `Content-Type`, are ignored as specified by OpenAPI.
- Undeclared path variables become string parameters; parameters absent from the template are dropped. Both produce diagnostics.
- `GET`/`HEAD` bodies remain descriptive but are unavailable to Fetch calls. `DELETE` bodies are supported. Incoming webhooks and callbacks retain their declared bodies.
- Root servers appear as comments, not client defaults. Path/operation servers warn and are ignored; set the client's `baseURL`.

Response types preserve declared statuses and ranges; the client applies [status precedence and bodyless responses](./client.md#status-typing).

## References

Only semantically reachable references cause document loading. Examples, extensions, and unused non-schema components do not. Resolution uses the document location, OpenAPI 3.2 `$self`, or the nearest schema `$id` in 3.1+. Targets can use JSON Pointers or `$anchor` names. JSON Pointer tokens escape `~` as `~0` and `/` as `~1`; malformed escapes produce `unresolved-ref`.

HTTP redirects set the base for relative references. Retrieval aliases address the same resource and anchors. If resources claim the same URI, the first referenced document retains it and its anchors. Each external OpenAPI document retains its own version semantics.

Non-schema Reference Objects are supported, including media types. In 3.1+, sibling `summary` and `description` override target annotations. Path Item chains merge nearer fields over inherited fields, warning on conflicts, while each field retains its original reference base. Non-schema reference cycles fail; recursive schemas can use `$ref`.

Retrieval boundaries apply to built-in and custom loading:

- HTTP(S) documents cannot reach local files, except by a URI that a local document explicitly publishes as its `$self`.
- Remote documents cannot claim local file URIs through `$id` or `$self`.
- Parsed object inputs cannot reference outside themselves, even with a custom loader. To load external references from an in-memory document, use an [entry URI and loader](./generation.md#load-an-in-memory-document-with-external-references).

IDs and anchors inside extensions, instance data (`example`, `examples`, `default`, `const`, `enum`), Links, or discriminator metadata claim no resources. Names such as `$id` inside a schema map are ordinary schema names. Explicit JSON Pointer references can activate schema indexing in otherwise filtered external dictionary entries; metadata inside the selected schema remains excluded unless itself explicitly referenced.

## Cross-version rules

These rules apply without warnings, including where a declared OpenAPI version does not define them:

- Binary string annotations and `type: file` receive transport-specific projections.
- `nullable` adds `null` wherever it appears, in 3.1+ too.
- Schema `$ref` siblings are applied in 3.0 as in later versions.
- `const`, `prefixItems`, `patternProperties`, conditionals, `additionalItems`, array/boolean `items`, null/type arrays, boolean schemas, and binary `contentMediaType` are applied in 3.0.
- `webhooks` works in 3.0; `query`, `additionalOperations`, `querystring`, and `itemSchema` work before 3.2.
- Request-body descriptions on `GET`, `HEAD`, and `DELETE` are accepted in 3.0; Fetch restrictions still apply.
- Lowercase status ranges such as `2xx` normalize to `2XX` and merge with equivalent entries.
- OpenAPI 3.0's directional requiredness for `readOnly`/`writeOnly` is retained in 3.1+.

## Precision and complexity limits

Large compositions can be widened to keep generated TypeScript usable:

| Case                                   | Limit and fallback                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Mixed object/array/scalar alternatives | Up to 16 alternatives. Beyond that, implied shapes may be dropped while definite type constraints remain.                |
| Nested mixed references                | One referenced-union level is distributed at a time; deeper cases can widen to either side.                              |
| Intersections of unions                | At most 10,000 combinations; largest unions widen to open objects or `unknown`.                                          |
| Read/write branch expansion            | At most 64 scopes or 4,096 traversal steps; potentially annotated requirements can become optional on the affected side. |

These losses produce `schema-precision-loss` with a reason and location. Widening retains annotations needed by outer read/write requirements. Exact simplifications do not warn, and omitted validation keywords do not all warn either.

Each `patternProperties` match, including regex compilation, has a 100 ms limit. A timeout stops generation with `invalid-document` identifying the pattern and property. This is a per-match limit, not a total generation deadline. Document size, loading concurrency, timeouts, and cancellation are described under [generation limits](./generation.md#limits-and-cancellation).

Semantic discovery and schema compilation share a budget of 1,000,000 work units. Input objects are checked iteratively and reject nesting beyond 512 levels before compilation. These limits are separate from document byte and retrieval limits.
