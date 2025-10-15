/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the anthropic ts sdk doesn't expose zod schemas for all of this..
 */
import * as AnthropicAPI from "./api";
import * as AnthropicMessages from "./messages";
import * as AnthropicTools from "./tools";

namespace Anthropic {
  export const API = AnthropicAPI;
  export const Messages = AnthropicMessages;
  export const Tools = AnthropicTools;
}

export default Anthropic;
