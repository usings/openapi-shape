# Consume streams

`api.stream()` returns a native `ReadableStream<Item>` synchronously. It shares the [client's inputs, defaults, and middleware](./client.md), but sends nothing until the first read, iteration, or pipe demands an item. Acquiring a reader alone does not send a request.

The examples use the client and API description from the [client guide](./client.md#create-a-client).

## Select a representation

Supported response media are `text/event-stream`, `application/jsonl`, `application/x-ndjson`, and `application/json-seq`:

<!-- example: client -->

```ts
for await (const pet of api.stream("GET /records", { headers: { accept: "application/x-ndjson" } })) {
  console.log(pet.id, pet.name)
}
```

An endpoint qualifies when an effective successful response declares a supported stream. Wildcards, `HEAD`, bodyless statuses, and error-only declarations do not qualify. An endpoint offering both JSON and a supported stream can use `result()` to decode its complete representation, `stream()` for streaming items, or `fetch()` for direct response access.

With one streaming declaration, `headers.accept` is optional. A single exact declared value narrows the item type and requires the actual response to match that same declaration. Lists, ranges, dynamic headers, or an omitted choice with multiple declarations retain a union of item types. With no Accept header the client advertises all supported declarations. Negotiated subscriptions use the actual response to choose a parser and make one connection; automatic SSE reconnection requires a single declared SSE choice. A wrong status, media type, or missing/consumed/locked body raises `StreamResponseError`; its `response` retains status and headers after cleanup. HTTP 204 closes normally.

Use `itemSchema` to describe one item, or an array `schema` to describe complete sequence content. An item schema takes precedence. SSE only narrows its standard message fields; it does not decode JSON in `data`. See [sequence projections](./openapi.md#sequence-projections) for the type rules.

## SSE messages

<!-- example: client -->

```ts
for await (const event of api.stream("GET /events", { retry: false })) {
  console.log(event.event, event.id, event.data)
}
```

Messages contain `data: string`, `event: string`, `id: string`, and optional numeric `retry`. Data lines join with newlines; the default event is `"message"`. Both named and default events are emitted. Comments and blocks without data emit nothing; incomplete events at EOF are discarded.

By default, EOF completes the subscription. Set `retry: {}` to enable reconnection, or provide a retry budget.

### SSE reconnection

When enabled, the default interval is 1000 ms with unlimited retries. Use `retry: { delay: 500, maxRetries: 3 }` to bound retries. Values must be non-negative safe integers; `maxRetries` counts additional attempts over the entire subscription, without resetting after messages. `0` allows only the initial connection.

| Outcome                                                                           | Behavior                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Normal EOF                                                                        | Reconnect; close normally when the retry budget ends.          |
| HTTP 204                                                                          | Close normally.                                                |
| Transport/read failure, HTTP 408, 429, or 500–599                                 | Retry; propagate the original failure when the budget ends.    |
| Other HTTP error, invalid response, construction error, or middleware's own error | Error immediately.                                             |
| Aborted call signal                                                               | Error with `signal.reason`, including while waiting or paused. |

A valid SSE `retry:` field replaces the interval. A valid HTTP `Retry-After` can increase an attempt's wait. With retries disabled, EOF closes and failures propagate.

Only completed SSE blocks update the resume cursor, including blocks with no data. Every reconnection reruns middleware and sends the latest cursor as UTF-8 bytes in `Last-Event-ID`; an empty ID clears the header. Reconnection does not deduplicate events or guarantee exactly-once delivery. Attempts made inside retry middleware are outside this retry budget. This API does not implement `EventSource`.

### Replay request bodies

The first demand builds the request; mutations before that point affect it. SSE reconnects reuse its URL and encoded inputs. With reconnection enabled, the body is buffered once and replayed with the same bytes, including multipart boundaries. One-shot Web streams and async iterables are rejected before transport in this mode.

JSON streams, SSE with `retry: false`, and SSE with `maxRetries: 0` send without pre-buffering and accept streaming upload bodies. Retrying a POST can repeat an operation; use reconnection only when replay is appropriate for the API.

## JSON records

JSONL and NDJSON emit parsed JSON values, including scalars. LF and CRLF separators are accepted, as is a valid final record without a trailing newline. Blank/whitespace-only records, a BOM, invalid JSON, and malformed UTF-8 raise `StreamParseError` with a one-based `line` and original `cause`. Error messages omit record contents.

JSON Text Sequences (`application/json-seq`) use an RS byte (`0x1E`) before each JSON value and can contain multiline values. Complete values followed by LF are delivered without waiting for the next RS. Malformed, BOM-prefixed, or truncated records and malformed UTF-8 are discarded; parsing resumes at the next RS. Consecutive RS bytes and bytes before the first RS are ignored. Top-level numbers, booleans, and `null` need trailing JSON whitespace. Complete objects, arrays, and strings may end at RS or EOF without LF; after delivery at LF, remaining bytes before the next RS are ignored.

JSON record streams close at EOF, reject automatic retry settings, and never reconnect automatically. Transport failures propagate and discard pending partial records. Reopening and deduplicating records belong to your application. Formats such as `application/example+json-seq` are not decoded by `stream()`; read them with `fetch()`.

## Limit message size

Set `maxMessageBytes` to bound a single message while it is being assembled:

<!-- example: client -->

```ts
const events = api.stream("GET /events", {
  maxMessageBytes: 8 * 1024 * 1024,
})
```

The limit is a positive safe integer in UTF-8 bytes; omitted means no limit. Each message has its own budget, across any number of received chunks. A chunk containing many small messages can exceed the limit in total, and a long-lived connection can transfer any amount of data.

| Format              | Bytes counted                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE                 | Field-line contents in the current event block, including field names, excluding CR/LF. Complete comment lines are discarded rather than accumulated; an unfinished line shares the current message's budget. |
| JSONL / NDJSON      | JSON text before LF, including whitespace and a preceding CR, if present.                                                                                                                                     |
| JSON Text Sequences | JSON text after RS, excluding RS and the terminating top-level LF; whitespace inside the record counts.                                                                                                       |

The parser checks before buffering more bytes or decoding a record. Exceeding the limit errors the stream with `StreamMessageTooLargeError`, which exposes `maxMessageBytes` and `receivedBytes`, and cancels the response body. This error terminates SSE without reconnecting, and JSON sequences do not discard it as a malformed record. Pending cleanup cannot delay the error.

The limit bounds per-message accumulation, not total process memory. Received chunks, decoded values, replay bodies, and transport buffers have their own memory costs.

## Cancellation and backpressure

The stream follows consumer demand and does not maintain an application event queue (`highWaterMark: 0`). Use `maxMessageBytes` to bound individual records.

Pass a call signal to stop a subscription, including a pending read or reconnection wait:

<!-- example: client -->

```ts
const stop = new AbortController()
const events = api.stream("GET /events", { signal: stop.signal })

// Call from your application's shutdown handler:
stop.abort()
```

Abort errors consumption with `signal.reason`. Reader/stream cancellation closes consumption normally; breaking a `for await` loop also cancels. Merely releasing a reader lock does not cancel. Call `stream.cancel()` only while unlocked. Visibility changes do not stop subscriptions.

Cancellation forwards the reason to the owned response reader, cleans up active work, and prevents reconnection. Explicit cancellation waits for that cleanup and rejects if it fails; an existing abort or parse error remains the consumer's error even if cleanup fails. Normal EOF releases resources without aborting a completed request.

Native pipe cancellation and error propagation apply. Await the pipe so destination errors reach your caller:

<!-- example: client -->

```ts
await api.stream("GET /events", { retry: false }).pipeTo(
  new WritableStream({
    write(event) {
      console.log(event.data)
    },
  }),
)
```

A failing destination cancels its source unless pipe options disable it. Also handle errors from your own asynchronous processing.
