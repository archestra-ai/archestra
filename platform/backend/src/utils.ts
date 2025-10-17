import type { FastifyRequest } from "fastify";

export function prepareErrorResponse(
  message: string,
  request: FastifyRequest,
  data?: object,
) {
  return {
    message,
    request: {
      method: request.method,
      url: request.url,
    },
    data,
  };
}
