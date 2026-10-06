# Site Mechanics

How pages are built, linked, and illustrated on the docs site. Follow these rules for every docs change.

## Pages and Frontmatter

The folder tree under `docs/pages/` is the navigation. A page's path is its URL: `docs/pages/knowledge/retrieval.md` is `/docs/knowledge/retrieval`. Every folder has an `index.md`, which is the folder's own page and gets an automatic **Explore** list of its children. Top-level folders are the sidebar sections. Nest at most four levels.

Keep `title`, `description`, `order`, and `lastUpdated` in frontmatter; update `lastUpdated` when content changes. `order` sorts a page among its siblings and must be unique among them. `description` is not shown on the page itself; it is the summary on the parent's Explore cards, in search metadata, and in the docs MCP server, so write it as one plain sentence. Set `explore: false` on a page that already links its children in its body, such as a numbered path, so the automatic Explore cards do not repeat them. Avoid `sidebarTitle`: a long, clear title is fine, because the sidebar wraps. Use it only when the full title would read badly in the sidebar. For a beta feature, never put "(Beta)" in the title or hand-write a beta callout. Set `beta: true` when `ARCHESTRA_BETA=true` turns the feature on: the site then shows the standard notice, "Beta feature. Turn on beta features with `ARCHESTRA_BETA=true`." Write your own sentence only when the feature has a different switch, such as `beta: "Set [`ARCHESTRA_X_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_X_ENABLED) to turn it on."`, or no switch at all. Start that sentence with "Set" when it names a variable. The site shows a Beta label in the sidebar and the notice under the title. For one beta section of a page, put `:::beta:::` (standard text) or `:::beta <sentence>:::` on its own line under that section's heading. Never hand-write a beta blockquote. For an alpha feature, use `alpha:` the same way: the label and notice then say Alpha. A child of a beta or alpha page shows no badge of its own in the sidebar, but keeps its notice. When only one section of a page is beta, put `:::beta <one sentence on how to turn it on>:::` on its own line under that section's heading, or `:::beta:::` when there is nothing to turn on. It renders the same notice. Never hand-write a beta blockquote.

Link to other pages with absolute paths (`/docs/chat`), never relative ones.

Preserve existing public URLs and inbound section anchors. Moves, renames, or deletions require a permanent redirect in `docs/redirects.json`; update inbound links and `platform/shared/docs.ts` where relevant. Use the user's existing branch/worktree when appropriate. Commit, push, open PRs, or publish only within explicit task authorization.

## Code Links

Some pages are linked from the app through `platform/shared/docs.ts` (a `DocsPage` slug map). When you rename, delete, or add a page that code links to, update that file — a stale slug there is a dead "Learn more" link in the product. The `.github/scripts/check-docs-links.py` CI job fails if a `docs.ts` slug has no matching page, and if any internal doc link, `#anchor`, or asset embed doesn't resolve. Anchors are heading slugs as the website renders them (github-slugger: lowercase, punctuation dropped, spaces to `-`, repeats suffixed `-1`), so renaming a heading breaks inbound `#links` — update them in the same change.

## OS-Specific Commands

When a command differs by platform, don't stack labeled blocks. Write adjacent fences tagged with `tab="…"`; the docs site renders them as one block with a tab each and opens the reader's OS:

````markdown
```bash tab="Linux / macOS"
docker run …
```

```powershell tab="Windows (PowerShell)"
docker run …
```
````

Always tag a fence with its language (`bash`, `powershell`, `yaml`, …); the block shows it as a label and highlights by it.

## Environment Variables

Every RBAC permission a page mentions links to its row on the Permissions page: [`agent:read`](/docs/reference/permissions#agent:read). The generator anchors each row by the permission name. CI enforces this with `.github/scripts/check-docs-permission-links.py`; run it with `--fix` to add the links.

Every environment variable a page mentions links to its exact entry on the Configuration page: [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA). The anchor is the variable's name verbatim; keep any `=value` inside the link text. Do not add a separate "See Configuration" pointer next to it — the link already goes there. Each entry on the Configuration page is a `- **`ARCHESTRA_X`** - …` bullet, which the site anchors by name; a new variable gets one there. CI enforces this with `.github/scripts/check-docs-env-var-links.py`; run it with `--fix` to add the links.

## Built-In MCP Tools

When a page names a built-in Archestra MCP tool (`list_skills`, `run_command`, `whoami`, …), link every mention to the tool's entry in the generated reference: [`list_skills`](/docs/reference/archestra-mcp-server#list_skills). The anchor is the tool's short name verbatim, without any `archestra__` prefix. This includes repeat mentions and mentions in tables; only code blocks and headings stay plain, since links don't render there. Per-skill tools generated at runtime (`skill__<name>`) are not built-in tools and have no entry. CI enforces this with `.github/scripts/check-docs-mcp-tool-links.py`; run it with `--fix` to add the links.

## Screenshots

Use a screenshot when a UI state helps readers follow a task or recognize a screen. Reference and explanation pages can use tables or diagrams instead.

Every screenshot of the product must match the current UI. When you edit a page, re-capture its product screenshots, and replace any hand-made product screenshot with a scripted one. An image of something else (another vendor's app, a logo) can stay if it is still accurate.

Never take app screenshots by hand. Every screenshot of the Archestra app comes from one script that seeds a demo organization and captures each shot in light **and** dark mode, so screenshots stay consistent and can be re-taken whenever the UI changes:

- **Add a shot** to `platform/docs-screenshots/src/manifest.ts`: the asset path, the route, and any steps to reach the state (open a dialog, switch a tab). If the shot needs data, add it to `src/dataset.ts` — fictional, generic names only, never a real customer.
- **Capture** from `platform/`: `ARCHESTRA_URL=http://localhost:3000 pnpm docs:screenshots` (all shots) or `DOCS_SCREENSHOTS_ONLY=automated_screenshots/<page-name> pnpm docs:screenshots` (one page). It works against any instance: seeding is additive and idempotent through the public API, signs in with `ARCHESTRA_AUTH_ADMIN_EMAIL`/`ARCHESTRA_AUTH_ADMIN_PASSWORD`, and captures as a seeded persona, never as your admin. Without Tilt, `pnpm test:e2e:lite:up` starts a stack on `:3000` (the same one CI uses).
- **Capture locally, before you push.** Run the capture against your own Tilt instance (or `pnpm test:e2e:lite:up`), then open every image you changed. CI re-captures on release PRs, but you own the first look.
- **Real seeded data only.** Never fake product data in the browser (`page.route` stubs for channels, statuses, or records). If a shot needs data, seed it: through the public API in `src/seed.ts`, or, when no API can create it (messaging channels a live bot would discover), as SQL in `src/db-seed.ts`. Both are additive and idempotent.
- **The persona owns everything.** The seed signs in as the instance admin only to create the persona. Then the persona creates every demo record and takes over any record an earlier run made. No shot may show the admin's default identity (`admin@example.com`, "Admin"). If one does, fix the seed or the framing, not the image.
- **The sidebar is always collapsed.** The capture sets it, so every shot gives the page the full width. Never re-open it in a shot's steps.
- **Output:** `docs/assets/automated_screenshots/{page-name}_{shot-name}.webp` (light) and `….dark.webp` (dark). Embed only the light file — `![alt](/docs/automated_screenshots/{page-name}_{shot-name}.webp)` — and the docs site shows the dark twin in dark mode. `{page-name}` is the page's URL path with `/` replaced by `-` (`workspace-knowledge-retrieval`); existing screenshots keep their names. Unchanged screens are left untouched, so a run only rewrites images that actually changed.
- **Clean chrome:** the capture sets docs screenshot mode (`archestra_docs_screenshot` cookie), which hides the sidebar community links, sidebar warnings (including default credentials), and onboarding dots on any instance. Don't hand-crop these out.
- **CI** runs the same command on release-please PRs and on a manual run of the **Docs** workflow, committing changed screenshots back (`.github/workflows/docs.yml`).

Screenshots of other products (Claude Desktop, Slack, Telegram, Grafana) can't be scripted. Keep them few, crop them tight, and never show real names, emails, or local paths.

## Diagrams

Draw a diagram only when the reader must see how parts connect or the order of a flow. Use a ```mermaid fence. The site renders it in the docs palette and redraws it when the reader switches between light and dark.

- **Never set colors.** No `style` lines, no `fill:#…`, no `%%{init}`. Hard-coded colors break dark mode and drift from the rest of the site.
- **Mark meaning with a semantic class** on flowchart nodes: `class Gateway accent` or `Gateway:::accent`. The classes are `accent` (the Archestra component the diagram is about), `guard` (a policy or security step), `ok` and `bad` (outcomes), and `external` (a system Archestra does not run). Use one or two per diagram. Leave every other node plain.
- **Keep it small.** About 12 nodes at most. Group with `subgraph`. Draw one edge between groups instead of one per node pair. Put the reader's entry point first (top or left).
- **Labels are nouns from the product.** Edge labels are short ("Gateway Token"), only where the edge is not obvious.
- **Sequence diagrams** suit auth and token flows. Name participants as the reader knows them: User, Archestra, Identity Provider.

The architecture figure on Get Started is a hand-built component in the website repository. Change it there, using the same palette.
