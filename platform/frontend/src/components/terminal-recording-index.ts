/** Boundaries at which a recorded screen can be inspected without cutting an
 * escape sequence. Keep every redraw boundary; a byte/line tail loses screens. */
export function indexTerminalRecording(content: string): number[] {
  const offsets = [0];
  let synchronized = false;
  const controls =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes are intentional
    /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\r?\n/g;
  for (const match of content.matchAll(controls)) {
    const token = match[0];
    if (token === "\x1b[?2026h") synchronized = true;
    if (token === "\x1b[?2026l") synchronized = false;
    if (synchronized) continue;
    // A clear/home starts a new screen; retain the preceding one. Synchronized
    // output termination is a complete TUI frame. Newlines cover ordinary CLIs.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: CSI screen controls delimit recorded frames
    const offset = /^\x1b\[(?:[23]J|(?:1;1)?H)$/.test(token)
      ? match.index
      : token === "\x1b[?2026l" || token.endsWith("\n")
        ? match.index + token.length
        : null;
    if (offset !== null && offset > offsets[offsets.length - 1])
      offsets.push(offset);
  }
  if (offsets[offsets.length - 1] !== content.length)
    offsets.push(content.length);
  return offsets;
}
