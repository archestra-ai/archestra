/**
 * Convert a PTY capture into readable plain text for the retained-log view.
 * The live terminal still receives the original bytes and renders the TUI.
 */
export function plainTerminalTranscript(value: string): string {
  let output = "";
  let index = 0;

  while (index < value.length) {
    const character = value[index];
    if (character === ESCAPE) {
      index = skipEscapeSequence(value, index + 1);
      continue;
    }
    if (character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\t" || character >= " ") {
      output += character;
    }
    index += 1;
  }

  return output;
}

function skipEscapeSequence(value: string, index: number): number {
  if (value[index] === "[") {
    index += 1;
    while (index < value.length) {
      const code = value.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return index;
  }

  if (value[index] === "]") {
    index += 1;
    while (index < value.length) {
      if (value[index] === BELL) return index + 1;
      if (value[index] === ESCAPE && value[index + 1] === "\\") {
        return index + 2;
      }
      index += 1;
    }
    return index;
  }

  return Math.min(index + 1, value.length);
}

const ESCAPE = "\u001b";
const BELL = "\u0007";
