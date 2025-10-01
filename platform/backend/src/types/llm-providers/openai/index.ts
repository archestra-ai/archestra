/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the openai ts sdk doesn't expose zod schemas for all of this..
 */
import * as OpenAiAPI from "./api";
import * as OpenAiMessages from "./messages";
import * as OpenAiTools from "./tools";

namespace OpenAi {
  export const API = OpenAiAPI;
  export const Messages = OpenAiMessages;
  export const Tools = OpenAiTools;
}

export default OpenAi;
