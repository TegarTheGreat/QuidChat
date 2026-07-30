import type { ServerResponse } from "node:http"

/**
 * Server-sent events for a chat turn.
 *
 * THE ANSWER IS NOT STREAMED TOKEN BY TOKEN, AND THAT IS DELIBERATE.
 *
 * Grounding validation runs on the *complete* answer: a segment claiming a warranty term is
 * only allowed through if it cites a chunk retrieval actually returned. Streaming raw
 * tokens would put text in front of a customer before that check has run — which is the
 * precise failure this product exists to prevent. A wrong price shown for two seconds and
 * then retracted has already been read.
 *
 * So the stream carries *progress*, and the answer arrives once, validated. "Add token
 * streaming" is the obvious next improvement and it would quietly break the central
 * promise, which is why this comment is here rather than in a design document nobody
 * opens.
 */

export type ProgressStage = "retrieving" | "generating" | "validating"

export function openEventStream(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nginx buffers proxied responses by default, which holds every event until the
    // response ends — turning a progress stream into a single delayed burst and making
    // this feature look broken in exactly the deployments that need it most.
    "x-accel-buffering": "no",
  })
}

export function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  // A blank line terminates an SSE event. Without it the client buffers indefinitely,
  // waiting for a frame that never completes.
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function sendProgress(res: ServerResponse, stage: ProgressStage): void {
  sendEvent(res, "progress", { stage })
}

/**
 * Sends the final payload and closes.
 *
 * The payload is byte-identical to what the non-streaming route returns for the same
 * request. Two shapes would drift, and only one of them would stay tested.
 */
export function sendResult(res: ServerResponse, result: unknown): void {
  sendEvent(res, "result", result)
  res.end()
}

/**
 * Reports a failure on an already-open stream.
 *
 * Headers are long gone by this point, so a 503 is impossible — the only way to tell the
 * client is an event. Without this the connection just closes and the widget cannot
 * distinguish a crash from a slow answer, so it waits forever.
 */
export function sendStreamError(res: ServerResponse, message: string): void {
  sendEvent(res, "error", { error: message })
  res.end()
}
