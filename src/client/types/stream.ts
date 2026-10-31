import type { StreamingEssence } from "../../shared/media"
import type { Empty, Endpoint, Essence, MethodOf, Operation, OperationOf } from "./endpoint"
import type { MediaHeader, WithHeaders } from "./headers"
import type { Args, Init } from "./request"
import type { Outcomes, StatusIn } from "./response"
import type { IsUnion } from "./utils"

/** One dispatched SSE event. Data is text, even when it contains JSON. */
export interface StreamMessage {
  data: string
  event: string
  id: string
  retry?: number
}

/** SSE connection attempts over the whole subscription, including the initial connection. */
export interface ReconnectOptions {
  /** Initial interval in milliseconds; a non-negative safe integer. Default: 1000. */
  delay?: number
  /** Total connections including the first; a positive safe integer. Omitted means unlimited. */
  maxAttempts?: number
}

/** The response representation, per-message byte limit, and SSE reconnection settings. */
export interface StreamOptions {
  /** Maximum UTF-8 bytes per message; a positive safe integer. Omitted means no limit. */
  maxMessageBytes?: number | undefined
  /** True enables SSE reconnection with defaults; false or omission disables it. */
  reconnect?: boolean | ReconnectOptions
}

/** Callable operations with a supported streaming success response. */
export type StreamEndpoint<E> = {
  [K in Endpoint<E>]: [StreamContent<OperationOf<E, K>, MethodOf<K>>] extends [never] ? never : K
}[Endpoint<E>]

type StreamsIn<Shape> = Shape extends { content: infer Content }
  ? {
      // Keep media presence even when its schema allows no values (content is never).
      [M in keyof Content & string]: Essence<M> extends StreamingEssence
        ? { media: M; content: Content[M] }
        : never
    }[keyof Content & string]
  : never

// Avoid expanding status ranges for operations that have no streaming media at all.
type StreamContent<Op extends Operation, Method extends string> = [
  StreamsIn<Op["responses"][keyof Op["responses"]]>,
] extends [never]
  ? never
  : Outcomes<Op, Method> extends infer Outcome
    ? Outcome extends [infer Status extends number, infer Shape]
      ? [Extract<Status, StatusIn<"2">>] extends [never]
        ? never
        : StreamsIn<Shape>
      : never
    : never

/** Declared streaming response media, including its original spelling and parameters. */
export type StreamMedia<E, K extends StreamEndpoint<E>> = StreamContent<
  OperationOf<E, K>,
  MethodOf<K>
>["media"]

/** One parsed item of the selected streaming response media. */
export type EndpointStreamItem<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K> = StreamMedia<E, K>,
> = StreamItem<Extract<StreamContent<OperationOf<E, K>, MethodOf<K>>, { media: M }>>

type StreamItem<Media> = Media extends {
  media: infer M extends string
  content: infer Content
}
  ? Essence<M> extends "text/event-stream"
    ? MessageOf<Content>
    : Content extends ReadonlyArray<infer Item>
      ? Item
      : unknown
  : never

/** A parsed SSE event, narrowed by itemSchema; data remains wire text. */
export type EndpointMessage<E, K extends StreamEndpoint<E>> = EndpointStreamItem<
  E,
  K,
  EventMedia<StreamMedia<E, K>>
>

type EventMedia<M extends string> = M extends unknown
  ? Essence<M> extends "text/event-stream"
    ? M
    : never
  : never

type MessageOf<Content> =
  Content extends ReadonlyArray<infer Item> ? EventItem<Item> : StreamMessage

type EventItem<Item> = Item extends object
  ? StreamMessage & Pick<Item, Extract<keyof Item, keyof StreamMessage>>
  : StreamMessage

type Replayable<Call> = Call extends unknown
  ? {
      [P in keyof Call]: P extends "body"
        ? Exclude<Call[P], ReadableStream | AsyncIterable<Uint8Array>>
        : Call[P]
    }
  : never

type StreamInit<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K>,
  D extends string,
  H = object,
> = Pick<StreamOptions, "maxMessageBytes"> & {
  headers?: MediaHeader<"accept", M, false>
} & StreamSelection<E, K, M, D, Init<OperationOf<E, K>, MethodOf<K>, D, H>>

type StreamSelection<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K>,
  D extends string,
  Call = Init<OperationOf<E, K>, MethodOf<K>, D>,
> = M extends unknown
  ? (IsUnion<StreamMedia<E, K>> extends true
      ? { headers: MediaHeader<"accept", M, true> }
      : { headers?: MediaHeader<"accept", M, false> }) &
      ReconnectSelection<Call, M>
  : never

/**
 * Stream arguments preserve required inputs and require replayable bodies only for reconnecting
 * SSE.
 */
// Keep the init tuple outside conditionals so accept can infer the selected media.
export type StreamArgs<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K> = StreamMedia<E, K>,
  D extends string = "application/json",
  H = object,
> =
  | ([K] extends [never] ? [init?: never] : never)
  | [init: StreamInit<E, K, M, D, H> & (IsUnion<K> extends true ? never : unknown)]
  | (IsUnion<K> extends true
      ? never
      : Empty extends StreamInit<E, K, M, D, H>
        ? [init?: undefined]
        : never)

/** Dynamic negotiation keeps all supported item types and performs a single connection. */
export type NegotiatedStreamArgs<
  E,
  K extends StreamEndpoint<E>,
  D extends string = "application/json",
  H = object,
> = Args<
  K,
  WithHeaders<Init<OperationOf<E, K>, MethodOf<K>, D, H>, NoInfer<H>> &
    Pick<StreamOptions, "maxMessageBytes"> & { reconnect?: false }
>

/** Defaults satisfy Accept only; the request keeps all of its own required fields. */
export type DefaultStreamArgs<
  E,
  K extends StreamEndpoint<E>,
  D extends string,
  A extends string,
  H = object,
  M = Extract<A, StreamMedia<E, K>>,
> = [M] extends [never]
  ? [init: never]
  : Args<
      K,
      M extends StreamMedia<E, K>
        ? DefaultSelection<WithHeaders<Init<OperationOf<E, K>, MethodOf<K>, D, H>, NoInfer<H>>, M>
        : never
    >

type DefaultSelection<Call, M extends string> = Pick<StreamOptions, "maxMessageBytes"> & {
  headers?: { accept?: never; [Symbol.iterator]?: never }
} & ReconnectSelection<Call, M>

type ReconnectSelection<Call, M extends string> =
  Essence<M> extends "text/event-stream"
    ?
        | (Replayable<Call> & { reconnect: boolean | ReconnectOptions })
        | (Call & { reconnect?: false | (ReconnectOptions & { maxAttempts: 1 }) })
    : Call & { reconnect?: false }
