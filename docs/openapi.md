# OpenAPI support

The generator supports OpenAPI 3.0, 3.1, and 3.2. This page describes how descriptions become TypeScript types, the [compatibility rules](#following-the-real-api) used for real APIs, and the [approximations](#approximations) arising from TypeScript limits and deliberate type assumptions.

## Support boundaries

OpenAPI and JSON Schema define the contract. The generator produces TypeScript types and runtime client settings, not runtime validation or proof of authenticity.

The types follow the supported features, [compatibility rules](#following-the-real-api), and [approximations](#approximations) on this page. Incorrect types within that scope are generator defects. Use the source contract for validation; successful generation does not certify that the document fully conforms to either specification.

## Versions and documents

### Supported input

- **Versions:** OpenAPI 3.0.x, 3.1.x, and 3.2.x. Each OpenAPI document uses its own `openapi` version; schema-only documents inherit the entry document's version. Swagger 2.0, unsupported versions, and entry documents without `openapi` are rejected.
- **Formats:** JSON and YAML, including YAML merge keys (`<<`).
- **Sources:** local paths, `file:` URLs, HTTP(S) URLs, and parsed objects.
- **Schema dialect:** the generator applies its documented projection rules for JSON Schema 2020-12 keywords. `$schema` and `jsonSchemaDialect` do not select a different rule set.

### References

References resolve against the document location, OpenAPI 3.2's `$self`, or the nearest schema `$id` in 3.1+. Targets may use JSON Pointers or `$anchor` names in any document. If multiple documents claim the same URI, the first referenced document keeps it, along with the anchors under that URI.

An `$id` or anchor inside an extension (`x-…`), instance data (`example`, `examples`, `default`, `const`, `enum`), a Link, or discriminator metadata is ignored: it claims no URI, and references inside it resolve against the base outside it. Discriminator mapping keys are payload values, including keys named `$id`, `$anchor`, or `$dynamicAnchor`.

External schema entries named `x-…`, `links`, `discriminator`, or an instance-data keyword can still be used through an explicit JSON Pointer schema reference. For files without `openapi`, that reference enables `$id` and anchor indexing along the pointer and within the target schema. Extensions and instance data inside the target remain excluded unless themselves explicitly referenced.

Non-schema Reference Objects are supported wherever components can be referenced, including 3.2 media types. In 3.1+, sibling `summary` and `description` fields override the target's annotations.

Path Item references merge every link in the chain. Nearer fields override inherited fields, with a `path-item-conflict` warning at each override. Relative references retain the base of the document where each field was defined. Reference cycles are rejected.

Retrieval follows these boundaries:

- An HTTP(S) document cannot reach local documents, except through the address a local document publishes as its `$self`.
- Remote documents cannot claim local file URIs through `$id` or `$self`.
- A parsed object without a `base` option cannot reference anything outside itself.

### Processing limits

Loading each local or HTTP(S) document, including external references, has a 30-second deadline and a size limit, 10 MiB by default, and loads run with bounded concurrency. [Loading and cancellation](./cli.md#loading-and-cancellation) describes the limits, how to change them, and how to cancel generation or supply a custom loader.

Parsed objects may share subobjects. Cycle detection checks each distinct object once per traversal and rejects cycles in the in-memory object graph, including those created by recursive YAML aliases. Recursive schemas expressed through `$ref` are supported.

Each `patternProperties` match, including compiling its pattern, has a 100 ms execution limit. A timeout stops generation with an `invalid-document` error that identifies the pattern and property name. No module is returned. The limit applies to each match, not total document loading or generation time.

## Operations

- **Methods:** `get`, `put`, `post`, `delete`, `options`, `head`, `patch`, and `trace`, plus 3.2's `query` and `additionalOperations`.
- **Parameters:** Path Item and operation parameters are merged by name and location; the operation wins on conflicts. Header names are case-insensitive. Parameter types come from `schema` or the single `content` entry.
- **Ignored headers:** header parameters named `Accept`, `Content-Type`, or `Authorization`, and response headers named `Content-Type`, are ignored as required by OpenAPI.
- **Path templates:** undeclared template variables become `string` parameters. Parameters absent from the template are dropped. Both cases produce diagnostics.
- **Request bodies:** bodies on `GET`, `HEAD`, and `DELETE` remain in `Endpoints`. The client cannot send a body with `GET` or `HEAD` because `fetch` does not allow it. Its callable endpoint types also exclude `CONNECT`, `TRACE`, and `TRACK`; those operations can still appear in generated types.
- **Servers:** root servers are listed in the module header. Path and operation servers produce an `ignored-field` warning. Configure a separate client for operations that need a different `baseUrl`.

## Media types

Each request or response `content` entry maps its media type to a TypeScript type in `Endpoints`. These types describe the content for clients and parsers; [client methods](./client.md#calls) determine how it is read at runtime.

| Media type                                                                                        | Type                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| JSON: `…/json`, `…+json`, and the wildcards `*/*` and `application/*`                             | Its schema (`unknown` without one)                              |
| `application/x-www-form-urlencoded`, `multipart/*`                                                | Its schema                                                      |
| Sequences with `itemSchema`: `text/event-stream` and JSON sequences                               | An array of its items                                           |
| JSON sequences: `application/jsonl`, `application/x-ndjson`, `application/json-seq`, `…+json-seq` | An array of `itemSchema` items, or of `schema` read as the item |
| Other `text/*`, including `text/event-stream` without `itemSchema`                                | `string`, or the schema's type when it says which strings       |
| The range `text/*`, which also covers JSON such as `text/json`                                    | The schema's type when it says which strings, else `unknown`    |
| Anything else: binary, XML, YAML, vendor types                                                    | `Blob`                                                          |

### Sequential content

For SSE and JSON sequences, `itemSchema` describes one item and the generated content type is an array of those items. The array represents the sequence's type; a client can process each item as it arrives. For JSON sequences without `itemSchema`, the generator reads `schema` as the item schema.

An SSE item is the parsed event: `data`, `event`, and `id` are strings, and `retry` is a number. JSON embedded in `data` can be described with `contentMediaType` and `contentSchema`, but the field remains a string. `api.stream()` infers the standard event fields from `itemSchema`; application code handles any further decoding. See [SSE events](./client.md#events).

### Binary content

For a `type: string` schema without `const` or `enum`, `format: binary` or a binary `contentMediaType` without `contentEncoding` produces `Blob`. Legacy `type: file` also produces `Blob`. In multipart content, these values represent file parts. A non-JSON text media type instead projects them as strings, and the range `text/*` as `unknown`. A binary media type itself produces `Blob`, even without a schema.

Encoding Objects do not change generated types. See [request bodies](./client.md#request-bodies) for how the client encodes them.

## Schemas

| Schema                                        | TypeScript                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`, annotations only                | `unknown`                                                                                                                                      |
| `false`, `not: {}`, `not: true`, empty `enum` | `never`                                                                                                                                        |
| `type`, including type arrays                 | `string`, `number` (also for `integer`), `boolean`, `null`, arrays, objects, or their union                                                    |
| `const`, `enum`                               | Literal types, including object and array literals; values outside `type` are dropped                                                          |
| `format`                                      | The original type plus `@format`; binary string schemas produce `Blob` as described above; `byte` remains text                                 |
| `items`, `prefixItems`                        | `T[]` or a tuple. Elements beyond `minItems` are optional; `items: false` closes the tuple. Recursive tuples use labels when needed to compile |
| `properties`, `required`                      | Required or optional properties. Undeclared required properties use `patternProperties`, `additionalProperties`, or `unknown`                  |
| `additionalProperties`, `patternProperties`   | An index signature, widened to admit the declared properties                                                                                   |
| `allOf`                                       | Intersection; plain object members are merged into one object                                                                                  |
| `anyOf`, `oneOf`                              | Union                                                                                                                                          |
| `if`/`then`/`else`                            | With `if` and `else`: `(if & then) \| else`; without `then`: `if \| else`                                                                      |
| `$ref`                                        | The target, intersected with the other keywords                                                                                                |
| `$dynamicRef`                                 | Resolved like `$ref` ([Approximations](#approximations))                                                                                       |
| `nullable: true`                              | The schema also admits `null`, wherever `nullable` appears                                                                                     |

Validation-only keywords such as `minimum`, `pattern`, `uniqueItems`, `contains`, `dependentRequired`, and `unevaluatedProperties` do not change the type. Some supported keywords extend earlier OpenAPI versions; see [Following the real API](#following-the-real-api).

### Discriminators

Discriminators narrow alternatives that the schema leaves open:

- In `oneOf` or `anyOf`, each referenced alternative is intersected with its mapped values, or its component name when no mapping applies. For example: `(Cat & { petType: "cat" }) | (Dog & { petType: "Dog" })`.
- A mapping value is a URI reference when it contains `/` or `#` or starts with a scheme, such as `urn:cat`; otherwise it is a component name.
- A component that extends a discriminated schema through `allOf` receives its own values and those of its descendants.
- Existing string literals on the discriminator property are preserved. Contradictory mappings and non-object alternatives produce a `discriminator-mismatch` warning.
- Inline alternatives and OpenAPI 3.2's `defaultMapping` target are not narrowed.

These narrowings follow the discriminator contract. Schema validation without the discriminator could accept additional values; see [Approximations](#approximations).

## Following the real API

Some descriptions express clear API behavior in ways their declared OpenAPI version does not define, or defines differently. The generator applies the following compatibility rules without warnings.

### Binary and nullable values

- **Binary values:** legacy `type: file` and strings declared as raw bytes become `Blob`, so upload and download types represent files. In 3.1+, the specification normally describes raw bytes without a `type`.
- **Nullability:** `nullable: true` admits `null` wherever it appears, including beside `$ref`, `enum`, and composition keywords. For example, `{ nullable: true, allOf: [Pet] }` becomes `Pet | null`. OpenAPI 3.0.3+ limits nullability to a sibling `type` that `enum`, composition, or `$ref` does not override. The generator applies it in 3.1+ too, where `nullable` is no longer defined.

### Operations and status codes

- **Request bodies:** bodies declared on `GET`, `HEAD`, and `DELETE` are retained, despite OpenAPI 3.0's instruction to ignore them. Real APIs use these declarations, including delete options; the client still cannot send bodies with `GET` or `HEAD`.
- **Status ranges:** lowercase ranges such as `2xx` are treated as `2XX` and merged with equivalent uppercase entries.

### References and keywords

- **Reference siblings:** keywords beside a schema `$ref` are applied in 3.0 as in 3.1+, intersecting the target with the sibling constraints.
- **Extended schema keywords:** `const`, `prefixItems`, `patternProperties`, `if`/`then`/`else`, `additionalItems`, array or boolean `items`, `type: "null"`, type arrays, boolean schemas, and binary `contentMediaType` are applied in 3.0 too.
- **Later operation fields:** `webhooks` is applied in 3.0; `query`, `additionalOperations`, `in: querystring`, and `itemSchema` are applied before 3.2. A JSON sequence's `schema` describes each item when `itemSchema` is absent.
- **Read/write annotations:** required `readOnly` and `writeOnly` properties retain OpenAPI 3.0's directional requiredness in 3.1+, even though those fields are annotations there. See [Input variants](./output.md#input-variants).

## Approximations

TypeScript cannot express every schema rule. The generator usually widens types to accept more values, but some assumptions below can also reject values the schema permits. These differences do not change the source contract.

### Deliberate type assumptions

- **Shape keywords imply a shape.** Object keywords such as `properties` and `required` imply an object; `items` and `prefixItems` imply an array. JSON Schema also allows other value types when `type` is absent. An explicit different type takes precedence in an intersection; mixed cases follow the [complexity limits](#complexity-limits).
- **Extra object properties are approximate.** Named properties alone do not create an index signature, so TypeScript may reject extra properties in object literals. Objects without named properties use an index signature: the additional/pattern property types, or `unknown` by default. Pattern types apply to all extra keys, and index signatures widen to admit named properties.
- **Dynamic references are static.** `$dynamicRef` resolves as `$ref`.
- **Raw bytes remain `Blob`.** Types preserve file declarations even in locations that require text. The client rejects a `Blob` inside JSON or text parameters, and generation reports `unsupported-request-encoding`. Use a textual schema, such as base64, or an already encoded body where supported. Whole `Blob` bodies and ordinary multipart file parts work normally.

Two additional narrowings come from outside JSON Schema:

- **Discriminators:** values are narrowed according to the discriminator contract, which rejects values no mapping selects. The schemas alone may allow them.
- **Prototype property names:** TypeScript compares names such as `toString` and `constructor` with `Object.prototype`. An object literal omitting an optional property with one of these names may fail to type-check.

### Constraints not represented

The following constraints are omitted or widened:

- Numeric and string constraints, `uniqueItems`, `contains`, `dependentRequired`, `dependentSchemas`, `unevaluated*`, and `propertyNames`.
- `not`, except `not: {}` and `not: true`.
- Conditionals without `else`, and the negation of `if` on the `else` branch.
- `oneOf` exclusivity.
- Key restrictions from `patternProperties` regular expressions.
- Object closure from `additionalProperties: false`.

### Complexity limits

Large compositions may be widened to keep TypeScript usable. These limits also apply through references:

| Case                                         | Limit and fallback                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed object, array, and scalar alternatives | Distribute up to 16 alternatives. Beyond that, implied shape constraints may be dropped to retain other value types; definite shape constraints remain.     |
| Nested mixed references                      | Distribute one referenced-union level at a time. Deeper cases may widen to either side, such as `{ b: unknown } \| S`.                                      |
| Intersections of unions                      | Keep at most 10,000 combinations by widening the largest unions. Object unions become open object types; other unions become `unknown`.                     |
| Read/write branch expansion                  | At most 64 scopes or 4,096 traversal steps. Beyond that, potentially annotated requirements become optional on the affected side; other constraints remain. |

Widening preserves read/write annotations needed by outer requirements. Read/write adjustments at a use site leave shared declarations and nested properties unchanged. See [Input variants](./output.md#input-variants).

These losses produce `schema-precision-loss`, with a reason and location. Exact simplifications do not warn, and neither does every omitted validation keyword.

### Verification

Tests compile generated modules against valid and selected invalid instances from the [official JSON Schema suite](https://github.com/usings/openapi-shape/blob/main/tests/fixtures/json-schema-test-suite/README.md), then exercise generated contracts through the client. Snapshots check output stability. These checks cover the documented behavior and known approximations; they do not establish complete schema validation or protocol conformance.
