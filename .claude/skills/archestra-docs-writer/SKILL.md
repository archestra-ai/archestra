---
name: archestra-docs-writer
description: Use when writing or editing Archestra documentation pages under docs/pages/ — new feature docs, page rewrites, tone or copy fixes, or capturing docs screenshots.
---

# Archestra Docs Writer

Follow `docs/docs_writer_prompt.md` first — it is authoritative and user-owned. Never modify it. Never edit the `<!-- -->` comment at the top of a docs page.

## Tone of Voice

**Every sentence states a fact: what a thing is, or what it does. If a sentence does neither, delete it.**

Sentence rules:

1. One idea per sentence. If it contains "and… so…", split it.
2. If a sentence needs re-reading, rewrite it. Roughly 15 words is the ceiling.
3. Common words: "use", "go to", "write" — never "leverage", "reside", "comprise".
4. No metaphors, idioms, or rhetorical hooks.
5. Name a thing once, then rely on context. Never the same noun three times in one sentence.
6. Active voice, present tense.
7. Second person for user actions; impersonal for system behavior.

Content rules:

8. A benefit is stated as a plain consequence ("so you can review what the agent did") — at most one per section.
9. Cut any detail that doesn't change how someone uses the feature: size limits, edge cases, ownership caveats, internal tool names, permission mechanics. Link to a reference page instead.
10. Don't describe what the UI or the screenshot already shows.
11. Headers are Title Case and name the thing ("Scheduled Tasks"), never the benefit.
12. Each page has a use case section with concrete, fictional data (never real customer names). The scenario comes from the user — ask for it before writing.

## Calibration Examples

| Rejected | Accepted |
|---|---|
| A chat answers a question and scrolls away; a project is where agent work accumulates. | A project is a shared workspace for chats, files, instructions, and scheduled tasks. |
| Chats started in a project belong to it for their lifetime, and files the agent saves are owned by the project rather than the individual author. | Files saved in a project are available to everyone in it. |
| Files the agent saves in a project chat go to the project, and every chat in the project can read them. | Files the agent saves go to the project. |
| …so anyone with access can use them. | …available to everyone in it. |
| ## Reports that write themselves: schedules | ## Scheduled Tasks |

Reference page in this voice: `docs/pages/platform-projects.md`.

## Screenshots

Capture with the Playwright MCP against the running platform at `localhost:3000` (docs run at `:3001` — never screenshot the docs site). Stage realistic data first: real project/team/file names from the page's use case scenario, forms pre-filled, scroll position checked. Save as `docs/assets/automated_screenshots/{page-name}_{shot-name}.webp` (convert PNG via the `sharp` package in `platform/node_modules`). Embed as `![alt](/docs/automated_screenshots/{page-name}_{shot-name}.webp)`.

## Page Frontmatter

`category` and `order` place the page in the nav (categories derive from frontmatter; no registry). Check sibling pages for free `order` slots. Update `lastUpdated` to today.
