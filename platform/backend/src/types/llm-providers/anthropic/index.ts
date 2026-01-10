/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the anthropic ts sdk doesn't expose zod schemas for all of this..
 */

import type { z } from "zod";
import * as AnthropicAPI from "./api";
import * as AnthropicMessages from "./messages";
import type { ModelSchema } from "./models";
import * as AnthropicTools from "./tools";

namespace Anthropic {
  export const API = AnthropicAPI;
  export const Messages = AnthropicMessages;
  export const Tools = AnthropicTools;

  export namespace Types {
    export type MessagesHeaders = z.infer<
      typeof AnthropicAPI.MessagesHeadersSchema
    >;
    export type MessagesRequest = z.infer<
      typeof AnthropicAPI.MessagesRequestSchema
    >;
    export type MessagesResponse = z.infer<
      typeof AnthropicAPI.MessagesResponseSchema
    >;
    export type Usage = z.infer<typeof AnthropicAPI.UsageSchema>;

    export type CustomTool = z.infer<typeof AnthropicTools.CustomToolSchema>;

    export type Model = z.infer<typeof ModelSchema>;
  }
}

export default Anthropic;
