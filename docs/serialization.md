# Request serialization

The [client](./client.md) uses generated contract metadata to encode parameters and request bodies. This page covers wire representation; [OpenAPI support](./openapi.md#media-projections) explains the corresponding TypeScript projections.

## Parameters and escaping

Path, query, and header values follow their declared styles or content encodings. For example, `deepObject` can encode `{ created: { gte: 1 } }` as `created[gte]=1`. Ordinary query parameters use parameter styles; an OpenAPI 3.2 `querystring` supplies the complete query using its media encoding. A pre-encoded form querystring string passes through unchanged.

- Path and ordinary query values use RFC6570 percent-encoding, including `!`, apostrophes, parentheses, and `*`. Delimiter commas remain literal; space and pipe delimiters are encoded.
- `allowReserved` preserves reserved characters and existing percent-encodings, except `?`, `#`, `[`, and `]` in paths, and additionally `&`, `=`, and `+` in queries/forms.
- Values creating empty, `.` or `..` path segments reject because URL normalization would target another resource. Missing or nullish path values also reject.
- `Date` values become ISO strings. Style-based query/form fields and array elements omit `null` and `undefined`; path and header arrays stringify nullish elements. Headers and non-JSON multipart parts omit nullish values.
- JSON parameters and JSON-typed fields preserve `null` and omit undefined properties. A `Blob` anywhere the client must write text or JSON is rejected.

Plain records and native buffers from other JavaScript realms retain their ordinary encodings; native detection uses brands rather than `Symbol.toStringTag`.

## Bodies and content types

For structured input, JSON media use JSON encoding, URL-encoded forms use a field map, `multipart/form-data` uses parts, and other text takes strings. Other media and sequential formats need an encoded string or ready body; an array is not automatically converted to SSE or JSON records.

The default request media is the sole `application/json` declaration, including its original case and parameters, or otherwise the sole declared media type. With multiple choices and no default, supply `contentType` using an exact declared key. Field encoding metadata is keyed by that full media type.

Ready bodies preserve their data: `Blob`, buffers, `FormData`, `URLSearchParams`, Web streams, and byte async iterables. `FormData` and `URLSearchParams` supply their own content types, overriding call headers. Other ready bodies use the selected/generated type unless call headers override it; without a concrete label, a `Blob` uses its own type. A wildcard cannot label a request body.

Byte async iterables are adapted to Web streams in browsers and Node.js. Canceling the request body closes the iterator when it provides `return()`.

For JSON, a string is a JSON value and gets quoted. Supply a ready body such as a typed `Blob` when you already have encoded JSON. URL-encoded strings, by contrast, are already encoded and pass through unchanged.

## Form field defaults

Without an explicit style, the generator derives a field's content type from its schema:

| Schema field                  | Default                                              |
| ----------------------------- | ---------------------------------------------------- |
| Object                        | `application/json`                                   |
| Primitive                     | `text/plain`                                         |
| Raw bytes or no explicit type | `application/octet-stream`                           |
| Array                         | The item's default, encoded separately for each item |

For example, `meta: { id: 1 }` becomes `meta=%7B%22id%22%3A1%7D` in a URL-encoded body. Arrays of objects repeat the field with one JSON value per item.

Content-based URL-encoded fields use the URL Standard serializer: a space becomes `+`, and literal `+` becomes `%2B`. This applies to form request bodies and complete form querystrings. Setting `style`, `explode`, or `allowReserved` explicitly instead selects RFC6570 parameter serialization, even at a default value.

Defaults follow references and compositions, including array items' `contentEncoding`. An inferred shape or `const` does not replace an explicit `type`. When a default is ambiguous, the generator warns; specify `encoding.contentType` or a style. Unnamed fields use fallback encoding.

## Multipart uploads

Multipart arrays repeat the field. A field's `contentType` applies to each part: JSON media encode JSON, and other media encode text. `Blob` and buffer parts keep their bytes, and `File` keeps its filename. `text/plain` values remain text fields; other explicitly typed non-file values become files named `blob`.

An explicit `style`, `explode`, or `allowReserved` overrides `contentType` and selects text serialization without percent-encoding. Supported styles are `form`, `spaceDelimited`, `pipeDelimited`, and `deepObject`. Styled fields cannot contain files or buffers, even nested; supply ready `FormData` instead. In OpenAPI 3.0, encoding style fields apply only to URL-encoded forms.

Other part headers, nested/positional encodings, unsupported styles, and content-type lists or wildcards are ignored with warnings. For those cases, use typed `Blob` parts, ready `FormData`, or a fully encoded body. Multipart types other than `multipart/form-data` always need an encoded body with its media type and boundary.
