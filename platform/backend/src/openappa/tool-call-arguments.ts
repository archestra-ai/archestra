/**
 * A tool call's arguments as JSON text. A call to a tool without parameters
 * can stream no argument text at all (GitHub Copilot's Chat Completions does
 * this for Claude models): that is an empty object, not cut-off input.
 */
export function toolCallArgumentsText(text: string): string {
  return text.trim() === "" ? "{}" : text;
}
