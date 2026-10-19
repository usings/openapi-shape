# OpenAPI support

The generator supports OpenAPI 3.0, 3.1, and 3.2. This page describes how descriptions become TypeScript types, the [compatibility rules](#following-the-real-api) used for real APIs, and the [approximations](#approximations) needed where TypeScript cannot express a schema exactly.

## Versions and documents

### Supported input

- **Versions:** OpenAPI 3.0.x, 3.1.x, and 3.2.x. Each OpenAPI document uses its own `openapi` version; schema-only documents inherit the entry document's version. Swagger 2.0, unsupported versions, and entry documents without `openapi` are rejected.
- **Formats:** JSON and YAML, including YAML merge keys (`<<`).
- **Sources:** local paths, `file:` URLs, HTTP(S) URLs, and parsed objects.
- **Schema dialect:** JSON Schema 2020-12 semantics apply regardless of `$schema` or `jsonSchemaDialect`.

### References

References resolve against the document location, OpenAPI 3.2's `$self`, or the nearest schema `$id` in 3.1+. Targets may use JSON Pointers or `$anchor` names in any document. If multiple documents claim the same URI, the first referenced document keeps it.

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
- **Request bodies:** bodies on `GET`, `HEAD`, and `DELETE` remain in `Endpoints`. The client cannot send a body with `GET` or `HEAD` because `fetch` does not allow it.
- **Servers:** root servers are listed in the module header. Path and operation servers produce an `ignored-field` warning. Configure a separate client for operations that need a different `baseUrl`.

## Media types

The generator uses the media type to determine request and response content types:

| Media type                                                                                        | Type                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| JSON: `…/json`, `…+json`, and the wildcards `*/*` and `application/*`                             | Its schema (`unknown` without one)                              |
| `application/x-www-form-urlencoded`, `multipart/form-data`                                        | Its schema                                                      |
| Sequences with `itemSchema`: `text/event-stream` and JSON sequences                               | An array of its items                                           |
| JSON sequences: `application/jsonl`, `application/x-ndjson`, `application/json-seq`, `…+json-seq` | An array of `itemSchema` items, or of `schema` read as the item |
| Other `text/*`, including `text/event-stream` without `itemSchema`                                | `string`, or the schema's type when it says which strings       |
| Anything else: binary, XML, YAML, vendor types                                                    | `Blob`                                                          |

### Binary content

Raw byte strings become `Blob`: `format: binary`, a binary `contentMediaType` without `contentEncoding`, or Swagger's `type: file`. In multipart content, these values represent file parts. Under `text/*`, they remain strings.

Encoding Objects do not change generated types. See [request bodies](./client.md#request-bodies) for how the client encodes them.

## Schemas

| Schema                                      | TypeScript                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`, annotations only              | `unknown`                                                                                                                                      |
| `false`, `not: {}`, empty `enum`            | `never`                                                                                                                                        |
| `type` (or 3.1+ `type` arrays)              | `string`, `number` (also for `integer`), `boolean`, `null`, arrays, objects, or their union                                                    |
| `const`, `enum`                             | Literal types, including object and array literals; values outside `type` are dropped                                                          |
| `format`                                    | The original type plus `@format`; `binary` produces `Blob`, and `byte` remains base64 text                                                     |
| `items`, `prefixItems`                      | `T[]` or a tuple. Elements beyond `minItems` are optional; `items: false` closes the tuple. Recursive tuples use labels when needed to compile |
| `properties`, `required`                    | Required or optional properties. Undeclared required properties use `patternProperties`, `additionalProperties`, or `unknown`                  |
| `additionalProperties`, `patternProperties` | An index signature, widened to admit the declared properties                                                                                   |
| `allOf`                                     | Intersection; plain object members are merged into one object                                                                                  |
| `anyOf`, `oneOf`                            | Union                                                                                                                                          |
| `if`/`then`/`else`                          | `(if & then) \| else`                                                                                                                          |
| `$ref`                                      | The target, intersected with the other keywords                                                                                                |
| `$dynamicRef`                               | Resolved like `$ref` ([Approximations](#approximations))                                                                                       |
| `nullable: true`                            | The schema also admits `null`, wherever `nullable` appears                                                                                     |

Validation-only keywords such as `minimum`, `pattern`, `uniqueItems`, `contains`, `dependentRequired`, and `unevaluatedProperties` do not change the type. Some supported keywords extend earlier OpenAPI versions; see [Following the real API](#following-the-real-api).

### Discriminators

Discriminators narrow alternatives that the schema leaves open:

- In `oneOf` or `anyOf`, each referenced alternative is intersected with its mapped values, or its component name when no mapping applies. For example: `(Cat & { petType: "cat" }) | (Dog & { petType: "Dog" })`.
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

Where a schema cannot be expressed exactly, the generator generally produces a wider type. The cases below and the compatibility rules above describe exceptions and limits.

### Deliberate type assumptions

- **Shape keywords imply a shape.** Without an explicit `type`, object keywords (`properties`, `required`, `additionalProperties`, `patternProperties`) imply an object; `items` and `prefixItems` imply an array. JSON Schema also permits other value types in these cases. In an `allOf` with a definite different type, such as `type: string`, the implied shape gives way. It also gives way to alternatives in a referenced union. Below the first such union, the generator widens to either side, such as `{ b: unknown } | S`, to avoid multiplying alternatives at every level.
- **Unmentioned properties are assumed absent.** Without `additionalProperties`, objects have no index signature. TypeScript's excess-property and weak-type checks can therefore reject extra properties in object literals. With only `patternProperties`, all extra properties use the pattern schemas' types.
- **Dynamic references are static.** `$dynamicRef` resolves as `$ref`.
- **Raw bytes remain `Blob`.** Binary schema values are typed as `Blob` even inside JSON, form fields, and parameters. Those locations carry text, so the client rejects a `Blob` there. The types preserve the document's file declarations.
- **Directional requiredness has reference limits.** A property required by a referenced `allOf` member remains required in requests even if another member marks it `readOnly`; the same limit applies to `writeOnly` in responses. A referenced schema's type is not changed for an individual use.

Two additional narrowings come from outside JSON Schema:

- **Discriminators:** values are narrowed according to the discriminator contract, which rejects values no mapping selects. The schemas alone may allow them.
- **Prototype property names:** TypeScript compares names such as `toString` and `constructor` with `Object.prototype`. An object literal omitting an optional property with one of these names may fail to type-check.

### Constraints not represented

The following constraints are omitted or widened:

- Numeric and string constraints, `uniqueItems`, `contains`, `dependentRequired`, `dependentSchemas`, `unevaluated*`, and `propertyNames`.
- `not`, except `not: {}`.
- `oneOf` exclusivity.
- Key restrictions from `patternProperties` regular expressions.
- Object closure from `additionalProperties: false`.

To keep output within TypeScript's complexity limits, intersections whose unions would expand beyond 10,000 alternatives widen their largest unions until the expansion fits. This includes unions reached through references or nested intersections. Object unions widen to any object; other unions widen to `unknown`.

`integer` is represented as `number`.

### Test coverage

Soundness is checked against a vendored subset of the official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite). Valid instances in included groups must type-check, except for the documented approximations above. Groups requiring remote documents or the metaschema are skipped; exclusions are listed in [the test runner](https://github.com/usings/openapi-shape/blob/main/tests/json-schema-suite.test.ts).
