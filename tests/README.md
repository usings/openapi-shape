# Test responsibilities

Tests are grouped by the behavior they establish, independently of source filenames.

| Directory        | Evidence                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `generator/`     | Document loading, references, schema projection, diagnostics and public output                    |
| `client/`        | Request/response behavior and native Web Streams, framing, cancellation and middleware            |
| `types/`         | Directly editable static assertions in baseline and strict optional/index modes                   |
| `integration/`   | Generated declarations used by the client, cross-file typing, live HTTP, CLI and packed consumers |
| `documentation/` | Explicit example contexts, generated excerpts, local links and published resources                |
| `support/`       | Temporary projects, compiler execution, HTTP fixtures and test-only transports                    |
| `fixtures/`      | Offline input corpora, provenance and representative generated output                             |

`pnpm verify` runs runtime tests, source type checking, both static type configurations,
lint and formatting. `pnpm test:node`, `pnpm test:browser` and `pnpm test:types`
select independent evidence. Root and static type checks resolve `openapi-shape/client` directly to source; they do not require a build. Packed-consumer tests separately verify the built public declarations. Chromium is the browser target; Node-only tests do
not establish CORS or opaque-response behavior.

Keep static assertions in real TypeScript files. Use temporary compiler projects
when generation, cross-file imports or platform compiler settings are the behavior
under test. Expected type errors must be checked by the compiler, including unused
`@ts-expect-error` directives. Compiler execution failures are not expected type failures.

Handwritten contracts isolate client runtime behavior. Their request and response
metadata must describe the test exchange. Integration tests generate their contracts
from OpenAPI instead of asserting an arbitrary inferred type onto runtime metadata.

Full output snapshots cover one example per OpenAPI version and the client fixture.
All official examples still generate without diagnostics and compile together.
Do not fix semantic tests to incidental formatting; preserve byte assertions where
the generated format itself is the requirement.

The JSON Schema corpus runs offline. Its named approximation allowances apply only
to assignability diagnostics, never compiler failures. They are an upper bound:
improved precision can pass without preserving a known loss. This is not a JSON
Schema validator conformance score.

Each TypeScript documentation block declares an explicit `example` context. Complete
examples compile on their own; client continuations receive the initialization shown
in the client guide; authentication examples explicitly assume the application hook.
The documentation test requires every TypeScript block to have a context.

The package smoke test builds and packs the actual distribution, then checks public
exports, generated declarations, a decoded response and CLI execution from a temporary
consumer. Declared generator dependencies are supplied from the local installation;
it does not test a fresh registry download.

HTTP fixture teardown owns open connections. Use explicit demand/read/cancel gates
for stream tests, fake clocks for retry intervals and real loopback HTTP when testing
native transport behavior. Do not repeat protocol cases merely to increase test counts.
