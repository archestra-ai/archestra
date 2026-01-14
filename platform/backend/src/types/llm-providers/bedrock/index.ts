/**
 * Amazon Bedrock type definitions for the LLM proxy
 *
 * Uses the Converse API format which provides a unified interface
 * for multiple foundation models.
 */

import type { z } from "zod";
import * as BedrockAPI from "./api";
import * as BedrockMessages from "./messages";
import type { FoundationModelSchema } from "./models";
import * as BedrockTools from "./tools";

namespace Bedrock {
  export const API = BedrockAPI;
  export const Messages = BedrockMessages;
  export const Tools = BedrockTools;

  export namespace Types {
    export type ConverseHeaders = z.infer<
      typeof BedrockAPI.ConverseHeadersSchema
    >;
    export type ConverseRequest = z.infer<
      typeof BedrockAPI.ConverseRequestSchema
    >;
    export type ConverseResponse = z.infer<
      typeof BedrockAPI.ConverseResponseSchema
    >;
    export type Usage = z.infer<typeof BedrockAPI.UsageSchema>;

    export type Message = z.infer<typeof BedrockMessages.MessageSchema>;
    export type ContentBlock = z.infer<
      typeof BedrockMessages.ContentBlockSchema
    >;
    export type ResponseContentBlock = z.infer<
      typeof BedrockMessages.ResponseContentBlockSchema
    >;

    export type Tool = z.infer<typeof BedrockTools.ToolSchema>;
    export type ToolSpec = z.infer<typeof BedrockTools.ToolSpecSchema>;
    export type ToolConfig = z.infer<typeof BedrockTools.ToolConfigSchema>;

    export type FoundationModel = z.infer<typeof FoundationModelSchema>;
  }
}

export default Bedrock;
