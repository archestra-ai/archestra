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
