# JSON Schema Test Suite (draft 2020-12, selected files)

Copied unchanged from [json-schema-org/JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite/tree/main/tests/draft2020-12)
at commit `55719286c33ae0d1823bfb65fea10338a19bc37c`. MIT licensed; see [LICENSE](./LICENSE).

Only keywords that can affect a TypeScript type, plus validation-only keywords
the generator must ignore soundly, are included. The separate `refRemote.json`,
`$vocabulary`, `format`, and `content` test files are not included.

The selected files contain 310 groups and 525 valid instances. The runner checks
all valid instances against generated types, with explicitly recorded existing
approximations. It also checks 70 invalid instances from 24 explicitly selected
groups whose constraints TypeScript can represent. This is a test of generated
types, not a JSON Schema validator conformance score.

The six groups in these files that require external resources run offline.
`remotes/sources.json` maps their original retrieval URIs to unmodified local
copies and records source URLs and SHA-256 hashes. The three localhost resources
come from the same suite commit above and use its MIT license. The eight
2020-12 meta-schema resources come from their versioned json-schema.org URLs;
their upstream license is retained in `remotes/LICENSE.spec`. Unmapped remote
URIs fail the test instead of accessing the network.
