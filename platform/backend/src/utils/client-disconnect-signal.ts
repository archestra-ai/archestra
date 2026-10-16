import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Turns a premature client disconnect into an AbortSignal for the work the
 * request started. Normal response closure does not abort, and listeners
 * remove each other on either terminal path.
 */
export function clientDisconnectSignal(params: {
  request: FastifyRequest;
  reply: FastifyReply;
}): AbortSignal {
  const { request, reply } = params;
  const controller = new AbortController();

  const cleanup = () => {
    request.raw.removeListener("aborted", onRequestAborted);
    reply.raw.removeListener("close", onReplyClosed);
  };
  const onRequestAborted = () => {
    cleanup();
    controller.abort();
  };
  const onReplyClosed = () => {
    cleanup();
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  };

  if (request.raw.aborted || reply.raw.destroyed) {
    controller.abort();
  } else {
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("close", onReplyClosed);
  }

  return controller.signal;
}
