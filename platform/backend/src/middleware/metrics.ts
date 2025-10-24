/**
 * Custom observability metrics middleware for fastify
 * in addition to comprehensive metrics collected by fastify-metrics
 */

import type {
  DoneFuncWithErrOrRes,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import client from "prom-client";

const requestCounter = new client.Counter({
  name: "total_request_count",
  help: "An example of a custom metric which counts all requests. Feel free to remove it.",
});

class RequestMetrics {
  public handle(
    request: FastifyRequest,
    reply: FastifyReply,
    done: DoneFuncWithErrOrRes,
  ) {
    requestCounter.inc();
    done();
  }
}

const requestMetrics = new RequestMetrics();
export { requestMetrics };
