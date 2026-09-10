# Chat layout — pay extra attention to gaps

When touching anything under `components/chat/` (or the `ai-elements/` building blocks the chat uses — `message.tsx`, `tool.tsx`, `reasoning.tsx`, `response.tsx`, `code-block.tsx`), pay extra attention to the **factual visible gap between objects** in the message stream.

Every block in an assistant turn — Thinking row, SkillPill, tool-call card, MCP app panel, file attachment, bubble row — must sit on the same vertical rhythm. The canonical gap is **16 px (`mb-4`)** between consecutive blocks. Anything else needs a specific, documented reason.

## Before changing or adding a block

1. **Measure the visible gap**, not the wrapper-to-wrapper margin. Internal `py-*` padding, negative `-mt-*` margins, and `pt-0` / `pb-0` overrides compound silently. A `mb-4` wrapper around a block whose neighbour has its own `py-2` produces a 24 px gap, not 16 px.
2. The same applies horizontally. Brain icon, assistant CompactCircle avatar, SkillPill, and tool-card headers share an implicit content column. The brain icon's center sits at the avatar's center (one `pl-2` shift from the column edge). Don't introduce per-block left offsets without re-aligning against neighbours.
3. If you add a new block kind, pick an adjacent existing block, eyeball the wrapper margins, then **verify with Playwright** that the visible top-to-bottom gap is exactly 16 px before merging. Don't trust the wrapper class alone.
4. Skill attribution and the tool-call `load_skill` indicator are intentionally the same visual (`SkillPill`). Keep them in sync — change one only via the shared component in `skill-pill.tsx`.
