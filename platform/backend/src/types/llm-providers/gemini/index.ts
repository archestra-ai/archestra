/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the gemini ts sdk doesn't expose zod schemas for all of this..
 */
import * as GeminiAPI from "./api";
import * as GeminiMessages from "./messages";
import * as GeminiTools from "./tools";

namespace Gemini {
  export const API = GeminiAPI;
  export const Messages = GeminiMessages;
  export const Tools = GeminiTools;
}

export default Gemini;
