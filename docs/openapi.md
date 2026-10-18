# OpenAPI support

Generation follows the OpenAPI and JSON Schema specifications, version by version. Where a document's letter and the API it describes part ways, the output follows the API, by the rules in [Following the real API](#following-the-real-api); where TypeScript cannot say what a schema says, the type is wider, never narrower, but for a few deliberate [approximations](#approximations).

## Versions and documents

- OpenAPI **3.0.x, 3.1.x, and 3.2.x**, each with its own rules. Every document in a description uses its own `openapi` version; schema-only documents use the entry document's. Swagger 2.0, other versions, and documents without `openapi` are rejected.
- JSON and YAML, from files, `file:` URLs, HTTP(S) URLs, or parsed objects. Schemas are read as JSON Schema 2020-12, whatever dialect `$schema` or `jsonSchemaDialect` names.
- References resolve as URIs, against the document's location, `$self` (3.2), or the nearest `$id` (3.1+). Targets can be any JSON Pointer or `$anchor`, in any document. A document fetched over HTTP(S) may not reach local documents, except by the address one publishes as its `$self`, nor claim local files' URIs through `$id` or `$self`, and a parsed object without `base` may not reference anything outside itself. When documents claim the same URI, the one referenced first keeps it. YAML merge keys (`<<`) are read.
- Non-schema Reference Objects resolve anywhere a component may be referenced, including 3.2 media types. In 3.1+, their `summary` and `description` override the target's. A Path Item `$ref` is merged with its local fields; local fields win, with a `path-item-conflict` warning.

## Operations

- Path Item methods: `get`, `put`, `post`, `delete`, `options`, `head`, `patch`, `trace`, plus `query` and `additionalOperations` (3.2).
- Parameters from the Path Item and the operation are merged. The operation's definition wins for the same name and location, and header names compare case-insensitively. Parameters are typed by `schema`, or by their single `content` entry.
- Header parameters named `Accept`, `Content-Type`, or `Authorization` are ignored, as the spec requires, as is a response header named `Content-Type`.
- Path parameters must match the path template. A template variable without a parameter is typed `string`; a parameter missing from the template is dropped. Both are reported.
- Request bodies on `GET`, `HEAD`, and `DELETE` are kept in `Endpoints`; the client cannot send one with `GET` or `HEAD`, as `fetch` cannot.
- The document's servers are listed at the top of the module. Servers of a path or operation are not applied (`ignored-field`): the client sends every request to its `baseUrl`, so use a second client for them.

## Media types

Content is typed by what its media type carries, in requests and responses alike:

| Media type                                                                                        | Type                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| JSON: `…/json`, `…+json`, and the wildcards `*/*` and `application/*`                             | Its schema (`unknown` without one)                              |
| `application/x-www-form-urlencoded`, `multipart/form-data`                                        | Its schema                                                      |
| Sequences with `itemSchema`: `text/event-stream` and JSON sequences                               | An array of its items                                           |
| JSON sequences: `application/jsonl`, `application/x-ndjson`, `application/json-seq`, `…+json-seq` | An array of `itemSchema` items, or of `schema` read as the item |
| Other `text/*`, including `text/event-stream` without `itemSchema`                                | `string`, or the schema's type when it says which strings       |
| Anything else: binary, XML, YAML, vendor types                                                    | `Blob`                                                          |

A string of raw bytes (`format: binary`, a binary `contentMediaType` without `contentEncoding`, or Swagger's `type: file`) is a `Blob` in a schema, as files are declared, and a multipart part with such a schema is a file; under `text/*` the content is a `string`. Encoding Objects do not change types. How the client encodes and decodes each class is in [Client](./client.md#request-bodies).

## Schemas

| Schema                                      | TypeScript                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`, annotations only              | `unknown`                                                                                                                                                         |
| `false`, `not: {}`, empty `enum`            | `never`                                                                                                                                                           |
| `type` (or 3.1+ `type` arrays)              | `string`, `number` (also for `integer`), `boolean`, `null`, arrays, objects, or their union                                                                       |
| `const`, `enum`                             | Literal types, including object and array literals; values outside `type` are dropped                                                                             |
| `format`                                    | Unchanged type plus `@format`. `format: binary` is raw bytes, a `Blob` ([Media types](#media-types)); `format: byte` is base64 text                               |
| `items`, `prefixItems`                      | `T[]`; tuples whose elements beyond `minItems` are optional, closed by `items: false`; labelled (`[_0?: T[]]`) where a recursive type would otherwise not compile |
| `properties`, `required`                    | Properties, required or optional. A required property that is not declared is typed from `patternProperties`, `additionalProperties`, or `unknown`                |
| `additionalProperties`, `patternProperties` | An index signature, widened to admit the declared properties                                                                                                      |
| `allOf`                                     | Intersection; plain object members are merged into one object                                                                                                     |
| `anyOf`, `oneOf`                            | Union                                                                                                                                                             |
| `if`/`then`/`else`                          | `(if & then) \| else`                                                                                                                                             |
| `$ref`                                      | The target, intersected with the other keywords                                                                                                                   |
| `$dynamicRef`                               | Resolved like `$ref` ([Approximations](#approximations))                                                                                                          |
| `nullable: true`                            | The schema also admits `null`, wherever `nullable` appears                                                                                                        |

Validation-only keywords (`minimum`, `pattern`, `uniqueItems`, `contains`, `dependentRequired`, `unevaluatedProperties`, …) do not change the type. Several rows go beyond what OpenAPI 3.0 or 3.1 defines; see [Following the real API](#following-the-real-api).

### Discriminators

A Discriminator Object is a hint that must not change validation. So it only narrows types a schema leaves open:

- In a `oneOf`/`anyOf`, each referenced alternative is intersected with its discriminator values: the `mapping` values pointing to it, or else its component name. An example is `(Cat & { petType: "cat" }) | (Dog & { petType: "Dog" })`.
- A component that extends a discriminated schema through `allOf` gets the values of itself and of every component extending it in turn.
- An alternative that already declares string literals for the property keeps them. An explicit mapping that contradicts them is reported (`discriminator-mismatch`), as is an alternative that is not an object.
- Inline alternatives and the 3.2 `defaultMapping` target are not narrowed.

## Following the real API

The generated code exists to call real APIs, and real descriptions do not always say by the letter of their OpenAPI version what the API does. Where a document's intent is evident, the output follows it. Every such reading is listed here, and none is warned about, since the reader of a warning can seldom change the document:

| The letter of the specification                                                                                                                                                                                                                                                                                                                                                                                  | The output                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 3.1+: a string is text; raw bytes have no `type`. `type: file` is Swagger 2.0.                                                                                                                                                                                                                                                                                                                                   | Such a string is read as raw bytes, a `Blob`, so that an upload takes a file and a download is one.        |
| 3.0.3+: `nullable` takes effect only through a sibling `type` that `enum`, `allOf`, `anyOf`, `oneOf`, or `$ref` do not override. 3.1+: no `nullable`.                                                                                                                                                                                                                                                            | `null` is admitted wherever `nullable: true` appears: `{ nullable: true, allOf: [Pet] }` is `Pet \| null`. |
| 3.0: a request body on `GET`, `HEAD`, or `DELETE` is to be ignored.                                                                                                                                                                                                                                                                                                                                              | The body is kept (Kubernetes delete options, Stripe), as 3.1+ allows.                                      |
| A status range is written with an uppercase X: `2XX`.                                                                                                                                                                                                                                                                                                                                                            | A lowercase range (`2xx`) means the same range, merged with an uppercase one.                              |
| 3.0: keywords next to `$ref` are ignored.                                                                                                                                                                                                                                                                                                                                                                        | They apply, as in 3.1+: the target intersected with them.                                                  |
| A keyword or field from a later version: `const`, `prefixItems`, `patternProperties`, `if`/`then`/`else`, `additionalItems`, an array or boolean `items`, `type: "null"`, `type` arrays, boolean schemas, or a binary `contentMediaType` in 3.0; `webhooks` in 3.0; `query`, `additionalOperations`, `in: querystring`, or `itemSchema` before 3.2. The `schema` of a JSON sequence before `itemSchema` existed. | Applied; a JSON sequence's `schema` types each item.                                                       |
| 3.1+: `readOnly` and `writeOnly` are annotations.                                                                                                                                                                                                                                                                                                                                                                | Required ones are required on one side only: [Input variants](./output.md#input-variants), as in 3.0.      |

## Approximations

TypeScript cannot express everything JSON Schema can. Where it cannot, the generated type is wider than the schema, never narrower, except in these deliberate cases (and the ones above):

- **Shape keywords imply a shape.** A schema without `type` whose keywords constrain only objects (`properties`, `required`, `additionalProperties`, `patternProperties`) is typed as an object, and `items`/`prefixItems` as an array. In JSON Schema such a schema also accepts other values. In an `allOf` with a definite other type (`type: string`), the implied shape gives way, as it does to the alternatives of a referenced union. Below the first such union, where alternatives would multiply level by level, the type widens to either side instead (`{ b: unknown } | S`).
- **Unmentioned properties are assumed absent.** Without `additionalProperties`, objects get no index signature, so TypeScript's excess-property and weak-type checks reject extra properties in object literals. With only `patternProperties`, every extra property is typed by the pattern schemas.
- **`$dynamicRef` is resolved statically**, as if it were `$ref`.
- **Raw bytes are a `Blob` wherever a schema declares them.** A raw-bytes property inside JSON, a form field, or a parameter is typed `Blob`, although these carry text; the client refuses a Blob there. Such documents describe files, so this stays the type uploads and downloads need.
- **One-sided requiredness does not reach into references.** A property that a referenced `allOf` member requires stays required in requests even when another member declares it `readOnly` (and likewise for `writeOnly` in responses); the referenced schema's own type is not changed for one user of it.

Two narrowings come from outside JSON Schema itself:

- Discriminator values (see [Discriminators](#discriminators)) narrow alternatives by OpenAPI's discriminator contract, under which a value no mapping selects is invalid. Validation by the schemas alone would allow it.
- TypeScript compares properties named like `Object.prototype` members (`toString`, `constructor`) with those members, so an object literal that omits such an optional property may not type-check.

Validation that TypeScript cannot express is dropped, and the type is wider:

- Numeric and string constraints, `uniqueItems`, `contains`, `dependentRequired`, `dependentSchemas`, `unevaluated*`, `propertyNames`.
- `not` (except `not: {}`).
- `oneOf` exclusivity.
- The regular expressions of `patternProperties` keys.
- `additionalProperties: false` closing an object.
- An `allOf` whose unions, including those behind references and inside intersections, would multiply into more than 10,000 alternatives widens its largest ones until they would not: a union of objects to any object, other unions to `unknown`.

`integer` is `number`. The generator's soundness is tested against the official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite): every valid instance must type-check, apart from the cases above.
