/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the gemini ts sdk doesn't expose zod schemas for all of this..
 */

import type { z } from "zod";
import * as GeminiAPI from "./api";
import * as GeminiMessages from "./messages";
import type { ModelSchema } from "./models";
import * as GeminiTools from "./tools";

namespace Gemini {
  export const API = GeminiAPI;
  export const Messages = GeminiMessages;
  export const Tools = GeminiTools;

  export namespace Types {
    export type GenerateContentHeaders = z.infer<
      typeof GeminiAPI.GenerateContentHeadersSchema
    >;
    export type GenerateContentRequest = z.infer<
      typeof GeminiAPI.GenerateContentRequestSchema
    >;
    export type GenerateContentResponse = z.infer<
      typeof GeminiAPI.GenerateContentResponseSchema
    >;
    export type UsageMetadata = z.infer<typeof Gemini.API.UsageMetadataSchema>;

    export type Candidate = z.infer<typeof GeminiAPI.CandidateSchema>;
    export type SystemInstruction = z.infer<
      typeof GeminiAPI.SystemInstructionSchema
    >;
    export type FinishReason = z.infer<typeof GeminiAPI.FinishReasonSchema>;

    export type Role = z.infer<typeof GeminiMessages.RoleSchema>;
    export type MessageContent = z.infer<typeof GeminiMessages.ContentSchema>;
    export type MessagePart = z.infer<typeof GeminiMessages.PartSchema>;

    export type Tool = z.infer<typeof GeminiTools.ToolSchema>;
    export type Model = z.infer<typeof ModelSchema>;
  }
}

export default Gemini;
