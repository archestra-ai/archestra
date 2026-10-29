/**
 * Jev LLM Provider Types - decisions only
 *
 * Jev answers typed classification questions about a piece of state. It has no
 * chat API, so this namespace carries only the decisions request/response.
 */
import type { z } from "zod";
import * as JevAPI from "./api";

namespace Jev {
  export const API = JevAPI;

  export namespace Types {
    export type DecisionsHeaders = z.infer<
      typeof JevAPI.DecisionsHeadersSchema
    >;
    export type DecisionsRequest = z.infer<
      typeof JevAPI.DecisionsRequestSchema
    >;
    export type DecisionsResponse = z.infer<
      typeof JevAPI.DecisionsResponseSchema
    >;
  }
}

export default Jev;
