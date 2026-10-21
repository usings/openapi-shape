# OpenAPI support

The generator supports OpenAPI 3.0, 3.1, and 3.2. This page describes how descriptions become TypeScript types, the [compatibility rules](#following-the-real-api) used for real APIs, and the [approximations](#approximations) needed where TypeScript cannot express a schema exactly.

## Coverage and guarantees

The references for version-specific behavior are [OpenAPI 3.0.4](https://spec.openapis.org/oas/v3.0.4.html), [3.1.2](https://spec.openapis.org/oas/v3.1.2.html), [3.2.0](https://spec.openapis.org/oas/v3.2.0.html), and [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-core). The compatibility rules below intentionally depart from those specifications in the stated cases.

Support has two separate boundaries: what the generated module describes, and what the fetch client can send or decode. Neither generated types nor the client validate server responses at runtime. Types describe the result expected from a server following its description.

| Area                            | Guarantee and limit                                                                                                                                                                                        | Verification                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versions and dialects           | Each OpenAPI document retains its version; schema evaluation uses 2020-12 semantics regardless of dialect declarations. Earlier-version extensions are compatibility rules, not strict version validation. | [Generation](https://github.com/usings/openapi-shape/blob/main/tests/generate.test.ts), [3.0 schemas](https://github.com/usings/openapi-shape/blob/main/tests/schema-30.test.ts), [2020-12 schemas](https://github.com/usings/openapi-shape/blob/main/tests/schema-2020.test.ts)                                                                                            |
| References and retrieval        | Resolve document and schema bases, anchors and pointers while enforcing retrieval boundaries. Dynamic references remain static approximations.                                                             | [References](https://github.com/usings/openapi-shape/blob/main/tests/references.test.ts), [loading](https://github.com/usings/openapi-shape/blob/main/tests/loading.test.ts), [offline official cases](https://github.com/usings/openapi-shape/blob/main/tests/json-schema-suite.test.ts)                                                                                   |
| Schema constraints              | Preserve representable types, literals, requiredness and tuple bounds. Other constraints may be widened, documented as annotations, or subject to the explicit narrowing assumptions below.                | [Valid and selected invalid official instances](https://github.com/usings/openapi-shape/blob/main/tests/json-schema-suite.test.ts), [discriminators](https://github.com/usings/openapi-shape/blob/main/tests/discriminator.test.ts)                                                                                                                                         |
| Input and output                | Preserve directional requiredness and nullable values, including across equivalent inline and referenced schemas within the documented reference limits.                                                   | [Generation invariants](https://github.com/usings/openapi-shape/blob/main/tests/generation-invariants.test.ts), [schema combinations](https://github.com/usings/openapi-shape/blob/main/tests/schema-2020.test.ts)                                                                                                                                                          |
| Parameters                      | Generated metadata carries serialization settings to the client. A typed declaration does not override fetch restrictions or the documented rejection of raw bytes in textual fields.                      | [Operations](https://github.com/usings/openapi-shape/blob/main/tests/operations.test.ts), [client](https://github.com/usings/openapi-shape/blob/main/tests/client.test.ts), [type-to-wire checks](https://github.com/usings/openapi-shape/blob/main/tests/protocol-contract.test.ts)                                                                                        |
| Bodies and media types          | Preserve media-type choices and supported form encodings. JSON, text and binary decoding follow the actual response Content-Type.                                                                          | [Media types](https://github.com/usings/openapi-shape/blob/main/tests/media-types.test.ts), [forms](https://github.com/usings/openapi-shape/blob/main/tests/form.test.ts), [multipart](https://github.com/usings/openapi-shape/blob/main/tests/multipart.test.ts), [type-to-wire checks](https://github.com/usings/openapi-shape/blob/main/tests/protocol-contract.test.ts) |
| Status and empty bodies         | Keep status, success/error and decoded body types related; HEAD and bodyless statuses take precedence over declared content. HTTP failures resolve, transport and decoding failures reject.                | [Client types](https://github.com/usings/openapi-shape/blob/main/tests/client-types.test.ts), [type-to-wire checks](https://github.com/usings/openapi-shape/blob/main/tests/protocol-contract.test.ts)                                                                                                                                                                      |
| Callbacks, webhooks and servers | Generate callback/webhook types; the client calls Endpoints only. Configure base URLs and authentication in the client rather than executing description metadata.                                         | [Operations](https://github.com/usings/openapi-shape/blob/main/tests/operations.test.ts), [official examples](https://github.com/usings/openapi-shape/blob/main/tests/fixtures.test.ts)                                                                                                                                                                                     |
| Generated artifacts             | Repeat generation is byte-stable for the same input and options. The contract version must match the client; a mismatch requires regeneration.                                                             | [Generation invariants](https://github.com/usings/openapi-shape/blob/main/tests/generation-invariants.test.ts), [format compatibility](./output.md#format-compatibility)                                                                                                                                                                                                    |

The [selected official suite](https://github.com/usings/openapi-shape/blob/main/tests/fixtures/json-schema-test-suite/README.md) checks valid instances for accidental narrowing and representable invalid instances for accidental widening. Existing exceptions must still reproduce: an exception that no longer fails is reported so it can be removed. Snapshot tests additionally protect output stability; their passing does not establish protocol completeness.

The distinctions below are intentional: **compatibility rules** interpret descriptions used by real APIs, **approximations** describe TypeScript's representational limits and explicit assumptions, and **diagnostics** report actionable unsupported or invalid input. They do not imply that every omitted validation constraint emits a warning. Changing one of these rules changes the public contract even when the generated code still compiles.

## Versions and documents

### Supported input

- **Versions:** OpenAPI 3.0.x, 3.1.x, and 3.2.x. Each OpenAPI document uses its own `openapi` version; schema-only documents inherit the entry document's version. Swagger 2.0, unsupported versions, and entry documents without `openapi` are rejected.
- **Formats:** JSON and YAML, including YAML merge keys (`<<`).
- **Sources:** local paths, `file:` URLs, HTTP(S) URLs, and parsed objects.
- **Schema dialect:** JSON Schema 2020-12 semantics apply regardless of `$schema` or `jsonSchemaDialect`.

### References

References resolve against the document location, OpenAPI 3.2's `$self`, or the nearest schema `$id` in 3.1+. Targets may use JSON Pointers or `$anchor` names in any document. If multiple documents claim the same URI, the first referenced document keeps it, along with the anchors under that URI.

An `$id` or anchor inside an extension (`x-…`), instance data (`example`, `examples`, `default`, `const`, `enum`), or a Link is ignored: it claims no URI, and references inside it resolve against the base outside it.

External schema entries named `x-…`, `links`, or an instance-data keyword can still be used through an explicit JSON Pointer schema reference. For files without `openapi`, that reference enables `$id` and anchor indexing along the pointer and within the target schema. Extensions and instance data inside the target remain excluded unless themselves explicitly referenced.

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
| The range `text/*`, which also covers JSON such as `text/json`                                    | The schema's type when it says which strings, else `unknown`    |
| Anything else: binary, XML, YAML, vendor types                                                    | `Blob`                                                          |

### Binary content

Raw byte strings become `Blob`: `format: binary`, a binary `contentMediaType` without `contentEncoding`, or Swagger's `type: file`. In multipart content, these values represent file parts. Under a text media type, they remain strings, and under the range `text/*`, `unknown`.

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

Soundness is checked against a vendored subset of the official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite). Valid instances in included groups must type-check, except for the documented approximations above. Selected invalid instances for representable constraints must fail to type-check. Referenced remote documents and metaschemas are loaded from pinned offline resources; an unmapped remote URI fails the test. The [test runner](https://github.com/usings/openapi-shape/blob/main/tests/json-schema-suite.test.ts) lists the tested negative groups and known approximation exceptions.
