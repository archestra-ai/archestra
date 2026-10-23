/**
 * A client's mark as the UI draws it: the glyph on its brand-colour tile. The
 * Connect page tile, agents made from the agent catalog, the client icon in
 * the LLM logs and the Plugin pages all render one mark the same way, so a
 * client looks alike everywhere.
 */
export interface ClientMark {
  /** viewBox of `path` and `accent.path`. */
  viewBox: string;
  /** The glyph. */
  path: string;
  /** Fill rule for a glyph whose holes are wound the same way as its outline. */
  fillRule?: "evenodd";
  /** Second-tone shape drawn beneath `path`, for two-tone marks. */
  accent?: { path: string; color: string };
  /** Glyph colour. */
  color: string;
  /** Tile colour behind the glyph. */
  background: string;
}

/** Pi Coding Agent's official mark: https://pi.dev/favicon.svg. */
export const PI_MARK: ClientMark = {
  viewBox: "0 0 560 560",
  path: "M420 280H280V140H0V0H420V280Z M560 560H420V280H560V560Z M140 560H0V140H140V280H280V420H140V560Z",
  color: "currentColor",
  background: "var(--muted)",
};
