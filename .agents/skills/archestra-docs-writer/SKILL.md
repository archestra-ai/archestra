---
name: archestra-docs-writer
description: Use when writing or editing Archestra documentation pages under docs/pages/ — new feature docs, page rewrites, tone or copy fixes, or capturing docs screenshots.
---

# Archestra Docs Writer

This skill is the single source of truth for Archestra docs. Write and edit `docs/pages/*.md` by these rules.

## Audience and Scope

Pages under `docs/pages/` are for end users deploying, configuring, and using Archestra. Omit contributor and local development details, including Tilt setup and development-only defaults. Keep those instructions in contributor documentation. Dedicated developer pages, such as `platform-developer-quickstart.md`, are exceptions.

## Process

1. Open the docs page you are editing.
2. Use whatever browser-automation MCP you have available (e.g. `claude-in-chrome`) to navigate the platform (not the docs site) for the feature you are documenting. Walk related screens and primitives so the page reflects what the software actually does.
3. Choose the page's audience, goal, and type using [Page Types](references/page-types.md). Infer these from the request and existing page; ask only when missing context changes the result.
4. Check factual claims in the current UI and implementation. For code-driven changes or a requested audit, read [Audit and Validation](references/audit-and-validation.md). Keep work within the user's scope.
5. State concepts and prerequisites clearly. Include the UI actions needed to complete a procedure, without narrating every visible control.

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
11. Keep constraints that change a user's decision or make a procedure work. Put exhaustive limits, permissions, and edge cases in reference pages; link to them from guides.
12. Don't describe what the UI or the screenshot already shows.
13. Headers are Title Case and name the thing ("Scheduled Tasks"), never the benefit.
14. Tutorials and how-to guides use a concrete fictional scenario when it helps the task. Reuse an approved scenario or infer one from the request. Reference and explanation pages do not require a fabricated use case. Never use real customer data.
15. No "Future Considerations" section and no generic "Best Practices" section.
16. Good docs are short docs. Keep every page as concise as the feature allows.

## Markdown Formatting

Keep each prose paragraph on a single source line, matching the existing docs. Do not insert line breaks after every sentence or hard-wrap paragraphs at a fixed column width. Short-sentence guidance concerns wording, not line breaks. Use blank lines between paragraphs; preserve Markdown structure for headings, lists, tables, and code blocks.

## Calibration Examples

| Rejected                                                                                                                                          | Accepted                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A chat answers a question and scrolls away; a project is where agent work accumulates.                                                            | A project is a shared workspace for chats, files, instructions, and scheduled tasks. |
| Chats started in a project belong to it for their lifetime, and files the agent saves are owned by the project rather than the individual author. | Files saved in a project are available to everyone in it.                            |
| Files the agent saves in a project chat go to the project, and every chat in the project can read them.                                           | Files the agent saves go to the project.                                             |
| …so anyone with access can use them.                                                                                                              | …available to everyone in it.                                                        |
| ## Reports that write themselves: schedules                                                                                                       | ## Scheduled Tasks                                                                   |
| Text and Markdown files are editable right in the panel, so a small fix doesn't need a re-upload.                                                 | Text and Markdown files are editable right in the panel.                             |

Reference page in this voice: `docs/pages/platform-projects.md`.

## Screenshots

Use a screenshot when a UI state helps readers follow a tutorial or how-to guide. Reference and explanation pages can use tables or diagrams without a screenshot. Capture them with your browser-automation MCP against the running platform at `localhost:3000` (docs run at `:3001` — never screenshot the docs site). Use fictional project/team/file names from the scenario. Avoid creating persistent sample resources unless the task authorizes it. Check the visible state and scroll position before capture. Save as `docs/assets/automated_screenshots/{page-name}_{shot-name}.webp` (convert PNG via the `sharp` package in `platform/node_modules`). Embed as `![alt](/docs/automated_screenshots/{page-name}_{shot-name}.webp)`.

### Always Capture in Dark Mode

Every screenshot in the docs is dark. One light shot in a dark set reads as a different product, so the mode is not yours to pick — it is dark whatever the machine you are on happens to be showing.

Use the platform's theme control to select dark mode when needed. Record the previous preference, verify the rendered theme, and restore that preference after capture. Follow the available browser tool's interaction rules.
Replacing an existing screenshot follows the same rule. A retake that comes back light is a regression even when the content is right.

## Page Frontmatter

Keep `title`, `description`, `category`, `order`, and `lastUpdated` in frontmatter; update `lastUpdated` when content changes. `docs/navigation.json` owns current navigation groups and order. Add each new page once. Frontmatter remains the fallback for older source snapshots without a manifest.

Preserve existing public slugs and inbound section anchors. Renames or deletions require a permanent redirect in `docs/redirects.json`; update inbound links and `platform/shared/docs.ts` where relevant. Use the user's existing branch/worktree when appropriate. Commit, push, open PRs, or publish only within explicit task authorization.

## Code References

Some pages are linked from the app through `platform/shared/docs.ts` (a `DocsPage` slug map). When you rename, delete, or add a page that code links to, update that file — a stale slug there is a dead "Learn more" link in the product. The `.github/scripts/check-docs-links.py` CI job fails if a `docs.ts` slug has no matching page, and if any internal doc link or asset embed doesn't resolve.

## Completion

Run the applicable commands in [Audit and Validation](references/audit-and-validation.md). Report what passed, what was only inspected, and what could not be exercised. Manual screenshots and skill instructions are review practices, not automated regression gates. Do not claim the skill guarantees factual accuracy or visual consistency.

## Upstream Attribution

Page-type and audit guidance is adapted from reviewed GitHub and Gemini CLI sources, rather than installed as separate skills. See [Attribution](references/attribution.md) for pinned revisions, modifications, and retained licenses.
