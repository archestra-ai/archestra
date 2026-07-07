---
name: archestra-docs-writer
description: Use when writing or editing Archestra documentation pages under docs/pages/ — new feature docs, page rewrites, tone or copy fixes, or capturing docs screenshots.
---

# Archestra Docs Writer

This skill is the single source of truth for Archestra docs. Write and edit `docs/pages/*.md` by these rules.

## Process

1. Open the docs page you are editing.
2. Use the Playwright MCP to navigate the platform (not the docs site) for the feature you are documenting. Walk related screens and primitives so the page reflects what the software actually does.
3. Document only the concepts, dependencies, and use cases. Skip anything the UI already shows on screen.

## Tone of Voice

Every sentence states a fact: what a thing is, or what it does. If a sentence does neither, delete it.

Sentence rules:

1. One idea per sentence. If it contains "and… so…", split it.
2. If a sentence needs re-reading, rewrite it. Roughly 15 words is the ceiling.
3. Common words: "use", "go to", "write" — never "leverage", "reside", "comprise".
4. No metaphors, idioms, or rhetorical hooks.
5. Name a thing once, then rely on context. Never the same noun three times in one sentence.
6. Active voice, present tense.
7. Second person for user actions; impersonal for system behavior.
8. Friendly, not dry: speak to the reader ("You can add your own files too"), give one tiny concrete example in passing ("a report, for example" — one, never a list), and use a dash for rhythm where it helps. Facts stay the substance; friendliness is the delivery.
9. No emojis.

Content rules:

10. A benefit is stated as a plain consequence ("so you can review what the agent did") — at most one per section.
11. Cut any detail that doesn't change how someone uses the feature: size limits, edge cases, ownership caveats, internal tool names, permission mechanics. Link to a reference page instead.
12. Don't describe what the UI or the screenshot already shows.
13. Headers are Title Case and name the thing ("Scheduled Tasks"), never the benefit.
14. Each page has a use case section with concrete, fictional data (never real customer names). The scenario comes from the user — ask for it before writing.
15. No "Future Considerations" section and no generic "Best Practices" section.
16. Good docs are short docs. Keep every page as concise as the feature allows.

## Calibration Examples

| Rejected | Accepted |
|---|---|
| A chat answers a question and scrolls away; a project is where agent work accumulates. | A project is a shared workspace for chats, files, instructions, and scheduled tasks. |
| Chats started in a project belong to it for their lifetime, and files the agent saves are owned by the project rather than the individual author. | Files saved in a project are available to everyone in it. |
| Files the agent saves in a project chat go to the project, and every chat in the project can read them. | Files the agent saves go to the project. |
| …so anyone with access can use them. | …available to everyone in it. |
| ## Reports that write themselves: schedules | ## Scheduled Tasks |
| Text and Markdown files are editable right in the panel, so a small fix doesn't need a re-upload. | Text and Markdown files are editable right in the panel. |

Reference page in this voice: `docs/pages/platform-projects.md`.

## Screenshots

Every page should open with at least one screenshot; add more where they help. Capture them with the Playwright MCP against the running platform at `localhost:3000` (docs run at `:3001` — never screenshot the docs site). Stage realistic data first: real project/team/file names from the page's use case scenario, forms pre-filled, scroll position checked so no important element is hidden. Save as `docs/assets/automated_screenshots/{page-name}_{shot-name}.webp` (convert PNG via the `sharp` package in `platform/node_modules`). Embed as `![alt](/docs/automated_screenshots/{page-name}_{shot-name}.webp)`.

## Page Frontmatter

`category` and `order` place the page in the nav (categories derive from frontmatter; there is no registry). Check sibling pages for free `order` slots. Set `lastUpdated` to today. Create a worktree or branch from `main`, and open a PR when you are done.

## Code References

Some pages are linked from the app through `platform/shared/docs.ts` (a `DocsPage` slug map). When you rename, delete, or add a page that code links to, update that file — a stale slug there is a dead "Learn more" link in the product. The `.github/scripts/check-docs-links.py` CI job fails if a `docs.ts` slug has no matching page, and if any internal doc link or asset embed doesn't resolve.
