# Repository instructions

- For work under `platform/`, read `platform/AGENTS.md` and any applicable nested `AGENTS.md` before editing. Run platform commands from `platform/`.
- OpenAPPA core lives in https://github.com/archestra-ai/OpenAPPA; this repo holds only its bindings (`platform/archestra-rs/openappa-rs`) and `docs/openappa-architecture.md`. For OpenAPPA work, use a local checkout of that repo (ask the user if none is found) and follow its agent instructions before editing.
- For work under `ai-labs/`, read `ai-labs/CLAUDE.md` before editing.
- Shared development skills live in `.agents/skills/`. Read the matching skill's `SKILL.md` before working in its domain. See `.agents/README.md` for client discovery and compatibility.
- When asked to add a PR to the merge queue or handle queue CI, load `.agents/skills/archestra-merge-queue/SKILL.md` and own the task until merged or an actionable blocker.
- Omit AI co-author trailers and generated-by footers from commit messages and PR titles/descriptions. Preserve human attribution.
