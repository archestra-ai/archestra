/**
 * A client's mark as the UI draws it: the glyph on its brand-colour tile. The
 * Connect page tile, agents made from the agent catalog, the client icon in
 * the LLM logs and the Plugin pages all render one mark the same way, so a
 * client looks alike everywhere.
 */
export interface ClientMark {
  /** Official product artwork rendered instead of the flat glyph. */
  imageSrc?: string;
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

// The Kimi Code mark is Kimi's K with its blue dot, from LobeHub Icons, and
// matches /agent-logos/kimi.svg.
export const KIMI_MARK: ClientMark = {
  viewBox: "0 0 24 24",
  path: "M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z",
  accent: {
    path: "M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z",
    color: "#1783FF",
  },
  color: "#18181b",
  background: "#f4f4f5",
};
