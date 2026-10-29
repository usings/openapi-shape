import type { StreamingEssence } from "../../shared/media"
import type { StreamMessage } from "../streams/sse-parser"
import type {
  Empty,
  Endpoint,
  Essence,
  IsUnion,
  MethodOf,
  Only,
  Operation,
  OperationOf,
} from "./endpoint"
import type { MediaHeader } from "./headers"
import type { Args, Init } from "./request"
import type { Outcomes, StatusIn } from "./response"

/**
 * Additional SSE connections allowed over the whole subscription, with a configurable initial
 * delay.
 */
export interface StreamRetryOptions {
  delay?: number
  maxRetries?: number
}

/** The response representation, per-message byte limit, and SSE reconnection settings. */
export interface StreamOptions {
  /** Maximum UTF-8 bytes per message; a positive safe integer. Omitted means no limit. */
  maxMessageBytes?: number | undefined
  retry?: false | StreamRetryOptions
}

/** Callable operations with a supported streaming success response. */
export type StreamEndpoint<E> = {
  [K in Endpoint<E>]: [StreamContent<OperationOf<E, K>, MethodOf<K>>] extends [never] ? never : K
}[Endpoint<E>]

export type StreamsIn<Shape> = Shape extends { content: infer Content }
  ? {
      // Keep media presence even when its schema allows no values (content is never).
      [M in keyof Content & string]: Essence<M> extends StreamingEssence
        ? { media: M; content: Content[M] }
        : never
    }[keyof Content & string]
  : never

// Avoid expanding status ranges for operations that have no streaming media at all.
export type StreamContent<Op extends Operation, Method extends string> = [
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

export type StreamItem<Media> = Media extends {
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

export type EventMedia<M extends string> = M extends unknown
  ? Essence<M> extends "text/event-stream"
    ? M
    : never
  : never

export type MessageOf<Content> =
  Content extends ReadonlyArray<infer Item> ? EventItem<Item> : StreamMessage

export type EventItem<Item> = Item extends object
  ? StreamMessage & Pick<Item, Extract<keyof Item, keyof StreamMessage>>
  : StreamMessage

export type Replayable<Call> = Call extends unknown
  ? {
      [P in keyof Call]: P extends "body"
        ? Exclude<Call[P], ReadableStream | AsyncIterable<Uint8Array>>
        : Call[P]
    }
  : never

export type StreamInit<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K>,
  D extends string,
> = Pick<StreamOptions, "maxMessageBytes"> & {
  headers?: MediaHeader<"accept", M, false>
} & StreamSelection<E, K, M, D>

export type StreamSelection<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K>,
  D extends string,
  Call = Init<OperationOf<E, K>, MethodOf<K>, D>,
> = M extends unknown
  ? ([Only<StreamMedia<E, K>>] extends [never]
      ? { headers: MediaHeader<"accept", M, true> }
      : { headers?: MediaHeader<"accept", M, false> }) &
      (Essence<M> extends "text/event-stream"
        ?
            | (Replayable<Call> & { retry: StreamRetryOptions })
            | (Call & { retry?: false | (StreamRetryOptions & { maxRetries: 0 }) })
        : Call & { retry?: never })
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
> =
  | ([K] extends [never] ? [init?: never] : never)
  | [init: StreamInit<E, K, M, D> & (IsUnion<K> extends true ? never : unknown)]
  | (IsUnion<K> extends true
      ? never
      : Empty extends StreamInit<E, K, M, D>
        ? [init?: undefined]
        : never)

/** Dynamic negotiation keeps all supported item types and performs a single connection. */
export type NegotiatedStreamArgs<
  E,
  K extends StreamEndpoint<E>,
  D extends string = "application/json",
> = Args<
  K,
  Init<OperationOf<E, K>, MethodOf<K>, D> &
    Pick<StreamOptions, "maxMessageBytes"> & { retry?: false }
>
