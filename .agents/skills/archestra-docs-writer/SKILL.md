---
name: archestra-docs-writer
description: Use when writing, editing, restructuring, or auditing Archestra documentation under docs/pages/ — new feature docs, page rewrites, sidebar and information-architecture changes, tone or copy fixes, diagrams, and docs screenshots.
---

# Archestra Docs Writer

This skill is the single source of truth for Archestra docs. Read all of it, and read [Site Mechanics](references/site-mechanics.md), before you change a page.

## The Bar

A reader opens a docs page to do one thing: understand a feature, finish a task, or look up a value. They skim. Many readers have little patience or attention to spare, and every reader is busy. Write for the reader who reads only the headings and the first line of each section. That reader must still get the answer.

The common failure is not wrong facts. It is the nervous-student answer: every detail packed in, every angle covered "just in case", nothing chosen. That is writing to protect the writer. **Your job is to choose.** Pick the one thing this reader needs, say it plainly, and cut the rest.

Most existing pages fail this bar. **Do not imitate the page you are editing.** Imitate the model pages, and treat everything else as a draft to fix.

**Model pages:**

- `docs/pages/agents/skills/` — a large feature area: index plus one subpage per task. A small feature stays on one page. Never invent subpages to match this model.
- `docs/pages/get-started/` — a path: numbered steps across pages, each ending with one **Next:** link.

Reference pages (configuration, permissions, API, the generated MCP tool reference) can be long. Their job is lookup, so they hold every user-facing setting, and nothing else. Every other page is a guide or an explanation, and length is a cost the reader pays.

## The Shape of a Section

Every section has the same shape. A reader learns it once and then scans every page fast.

1. **The bottom line first:** one plain sentence that says what this is, what you do here, or the rule of thumb. No warm-up.
2. **Then the body, as one of:**
   - numbered steps, when the reader does something;
   - a short list, when there are options, cases, or ways. Lead an item with a short bold label (one to four words) only when the reader scans for it, such as a setting or an option name;
   - a table, only when the reader compares options across the same columns.
3. **Then at most three "What to know" bullets** for the facts a reader could get wrong.

Rules that keep it scannable:

- **No paragraph longer than three sentences.** If it is longer, it is a list.
- **When there are several ways, list them.** "A skill runs in one of three ways:" then three bullets. Say which way this page covers.
- **Bold is for UI labels.** Bold the text the reader sees on screen: **Save**, **Settings → Knowledge**. Do not bold a page's or a section's first sentence, and do not bold a sentence inside a list. When most lines carry bold, bold marks nothing.
- **One link per thing per section.** Link a tool, page, or setting the first time. Name it plainly after that.
- **Every `###` sits under the `##` it belongs to.** A page with subsections needs an `##` before the first one, or the subsection lands under "Overview" in the table of contents.

## The First Line Earns the Reader

Cutting makes a page short. It does not make it worth reading. The most common draft that passes every rule here and still fails is the **flat opener**: a true, short sentence that any product's docs could say. "The MCP Registry is your organization's list of MCP servers." "Archestra logs every model request." The reader learns what the thing is called, not why to care.

The first line of a page or a section must pass three tests:

1. **Outcome, not definition.** Say what the reader gets or can now do. "Know what every agent did, as whom, and what it cost" beats "Archestra logs every request".
2. **Concrete.** Give one real example the reader can picture: "Ask an agent to open a GitHub issue with your account, and the issue shows your name."
3. **Only Archestra could say it.** If the sentence is true of any tool in the category, it is filler. Name the hard part Archestra does for the reader: runs the server in your cluster, signs in as each person, keeps credentials out of clients.

Then:

- **Do not undersell an overview.** A feature's index page names its headline capabilities, the ones a reader would be surprised to learn. Short is good. Leaving out the reason to use the feature is not.
- **Every section opens with that first line,** including a section that holds only steps, a table, or a list. Never open a section with the list itself.
- **Lead with the shortcut** when most readers need none of the section: "With the quickstart or the Helm chart, there is nothing to set up." "You may not need to create one."
- **A section's lead must not restate its steps.** "Name it, pick its tools, and choose who can use it" over three steps that do exactly that is a wasted line. Say what the reader gets, or when they do not need the section.
- **Define a standard in one line, and link its spec.** ID-JAG, On-Behalf-Of, and CIMD mean nothing to most readers. "ID-JAG lets your identity provider decide which MCP servers each person can use" plus the spec link.
- **Define a product term the first time a page uses it, or do not use it.** "All tool mode", "caller", "orchestrator", and "coordinator" mean nothing to a new reader. Say what the reader sees: "every tool the person can use".
- **A heading must make sense alone** in the table of contents and say what the section gets the reader. "The Tabs", "The Parts", and "Share One Account" do not. "What Gets Logged" and "Install a Team Service Account" do.

To check: read only the first lines of the page, in order. If they do not make a reader want the feature and know what to do, rewrite them before you touch anything else.

## Depth Follows Difficulty

Short is not the goal. **Easy to scan** is. A simple feature needs a few lines. A hard one, such as authentication, identity, or a cluster runtime, needs more, and cutting it to a definition and two steps fails the reader as badly as padding does.

For a hard topic, each section answers what the reader will ask next:

1. **When do I use this,** instead of the other ways?
2. **What does it unlock** for me?
3. **What exactly do I do,** with the real values and a success check?
4. **What gets checked,** and what makes it fail?
5. **How do I debug it** when it fails?

Keep each answer to a line or a short list. Skip the ones the reader would not ask. Do not skip the ones they would.

**Document the product's path, not the mechanism.** Before you write a step, find the shortest way the product offers: a guided page, a picker, a button. "Copy the endpoint into your client" is wrong when the Connect page can pick the gateway for you. Raw mechanics go only where no guided path exists, such as a script or a custom app. An API call is not a fix for someone working in the UI: when a UI task can be done only through the API, such as restoring an uninstalled server, leave it out of the page and tell the user the UI has a gap.

**Write troubleshooting as symptoms.** Key each row to what the reader sees in the product ("Failed to start", "Starting for minutes"), then the fix. Check in the code which symptoms the product really shows. "Image not found? Check the image" is advice, not help.

**Cut trivia, not substance.** A true feature that no reader would miss, such as version history on a gateway, is trivia. Cut it. The checks a token must pass are substance. Keep them.

## Choose, Then Cut

"It is true" is not a reason to keep a sentence. It must be true **and** needed by this reader on this page. Delete these on sight:

1. **Internals.** Source paths, function names, database tables, internal services, cache keys, protocol mechanics, how a value travels. Contributor pages under `contributing/` are the only exception.
2. **Edge cases.** Keep a limit or condition only if it changes the reader's decision, makes a step work, or would otherwise trip them. Delete the rest. Do not move it to a reference page.
3. **Restated settings.** When you link an environment variable or setting, say why a reader would change it. Do not repeat its default, values, or caveats. The reference entry holds those.
4. **Product lists repeated.** Do not name every client, provider, or tool in every sentence. Say "your coding agent" or "your client". Name one only where its behavior differs: a command tab, an exception ("Cursor is the exception"), a limit.
5. **Narrating the UI.** "The page shows a toggle next to the name." The reader can see it. Name a control only when the reader must use it.
6. **History.** "New", "now", "previously", "no longer". Docs describe the current product. A hard version requirement stays, as a prerequisite: "Requires OpenCode 1.17 or newer".
7. **Repetition.** An intro that restates the title. One fact on three pages. One fact lives on one page. Others link to it.
8. **Navigation boilerplate.** "## Overview", "## Introduction", "## Summary", "## Related", "## Next Steps", "See also" lists, "This page describes…", and a "The Parts" or "Pick a Page" list of the child pages. The sidebar and Explore cards do this. A path page ends with one **Next:** link, nothing more.
9. **Filler and marketing.** Minimizing words ("simply", "just", "easily"), throat-clearing ("note that", "it is important to", "in order to", "allows you to"), and praise ("powerful", "seamless", "robust", or any synonym).
10. **Hedges** that protect the writer instead of informing the reader.

### Delete Pages, Too

A page must earn its place. Ask: **would a reader open this page on purpose?** If not, delete it. Fold the one or two facts a reader needs into the parent page, add a redirect, and move on. A "Managing X" page that lists every admin action is the usual suspect. So is a "Manage" or "Advanced" subpage split off a page that was too long: cut the page instead.

A small fact gets a section, not a page. Licensing fits in two paragraphs on Get Started, so it has no page of its own.

## Too Little

These are defects too:

1. **Stub pages.** An index that says "This section covers…" and lists children. Give it a real front door, or remove the folder.
2. **Steps without the how.** "Configure the provider in Settings." Name the path, the control, and the value: "Go to **Settings → LLM → Model providers**, click **Add provider**, and paste the API key."
3. **Missing prerequisites,** stated before step 1.
4. **No example** when the reader would otherwise guess the shape. Show the lines that matter, not a whole file. Tag every code block with its language.
5. **No way to check success.** A procedure ends with what the reader sees when it worked.
6. **No decision help.** When the reader must choose between two things (skills or agents, one provider or another), give a rule of thumb, a table with one concrete example per row, and two or three reasons.

## Never Claim More Than the Product Does

A docs sentence is a promise. Each of these broke one:

- **"Most other coding agents"** when the setup flow accepts five. Say exactly what works, and name the fallback for the rest.
- **"Supports Hermes"** when the code has nothing Hermes-specific. A name in a README is not support.
- **"Click Reset to default"** when only the API has a reset. An API route is not a UI control. Name a control only after you see it in the running product.
- **"Hooks need the Code Sandbox"** when the sandbox is on by default. A true prerequisite that is almost always met only worries the reader. State it only where it can fail.

Verify every claim against the running product and the code. If you cannot verify it, delete it or flag it in your report. Never keep it silently.

## Information Architecture

The sidebar is the product's map. A reader who knows the product must find a page without searching.

- **Groups** are product areas the reader recognizes, named as the product names them.
- **A page is one subject a reader looks for by name:** a feature, a task, or an integration. Split by the reader's tasks (Writing, Importing, Sharing), never by implementation layer.
- **An index page** is the front door: a one-sentence definition, the ways to use it, one screenshot, the core usage. Its children cover the rest. The site adds an Explore card for each child from its `description`.
- **A path** (like Get Started) is numbered: the index lists the steps, each step page ends with one **Next:** link.
- **Split** a page into a folder only when it covers subjects a reader looks up separately (one page per connector or provider with real setup). Never nest a single page alone.
- **Merge** pages a reader would read together, or that repeat each other.
- **Reference vs guide.** Exhaustive tables go under Reference. Guides link to the exact entry.
- **Split by reader.** When users and operators share a page, give the operator content its own **Setup** page: cluster prerequisites, install commands, provider tables, and install troubleshooting. Put it first among the children, because it comes first in time. The index stays for the person who uses the feature.
- **Length.** A guide reads in five minutes: usually 200–800 words. Past about 1,000 words, cut first, then split. A Setup page can run to about 1,200 words when commands and tables make up the length, not prose. A reference page grows with its settings, never with padding.
- **Titles.** Name the thing ("Connect Your Agents", "Claude Code"), not the benefit or a pitch ("Using Claude Code with a Pro Subscription"). Long, clear titles are fine. The sidebar wraps.
- **Order** follows the reader's path: what it is, how to use it, then rarer tasks.

Every move, rename, or deletion needs a redirect. See [Site Mechanics](references/site-mechanics.md).

Give each page one job. Link between pages instead of mixing jobs:

- **Guide:** the reader finishes a task. Prerequisites, steps, how to tell it worked.
- **Explanation:** the reader understands how something works and when to use it. A diagram often helps.
- **Reference:** the reader looks up an exact value.

## Voice

Every sentence states a fact: what a thing is, or what it does. If it does neither, delete it.

1. One idea per sentence. Aim for about 15 words. If a sentence needs re-reading, rewrite it.
2. Common words: "use", "go to", "write". Never "leverage", "reside", "comprise".
3. Active voice, present tense. Second person for the reader's actions. Impersonal for system behavior.
4. No metaphors, idioms, rhetorical hooks, greetings, "Let's", or "In this guide".
5. A benefit is a plain consequence ("so their work is safe"), at most one per section.
6. Never point at a step by its number ("in step 4"). Name the control ("under **Authentication & subpath**"). Step numbers change and the reference goes stale silently.
7. Headings are Title Case and name the thing ("Snapshot Links"), never the benefit. Task headings use the imperative ("Import from GitHub").
8. Do not state what readers assume, that a feature works as named. Document defaults, toggles, and conditions a reader could get wrong.
9. No emojis. No "Future Considerations" or generic "Best Practices" sections.
10. Never use real customer names, people, emails, or data. Use fictional, generic examples.
11. Never say a step needs a role ("you need the Admin role", "only admins can"). Access is RBAC, and custom roles change what each role holds. Name the exact permission instead, linked to its row: [`openappaPolicy:update`](/docs/reference/permissions#openappaPolicy:update). For a per-item grant, name the actions and link [Granular Access Control](/docs/admin/access-control#granular-access-control). CI checks the links with `check-docs-permission-links.py`.

Keep each prose paragraph on one source line. Do not hard-wrap. Use only the Markdown and the `:::` directives that [Site Mechanics](references/site-mechanics.md) lists. Never invent admonitions such as `> [!NOTE]` or `:::warning`.

## Calibration

| Rejected | Accepted | Why |
| --- | --- | --- |
| Clients pick up changes: Claude Code's setup turns on marketplace auto-update… the setup also wraps Claude Code, Codex, Copilot CLI, and OpenCode in the shell to refresh after an interactive session, at most once a day. Cursor installs update with… | Clients pick up skill changes on their own. Cursor is the exception. Pull the changes yourself: *(command)* | Choose the one fact. Name a client only for the exception. |
| `ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR` holds the generated repositories. Defaults to `~/.archestra/…`. It is safe to wipe… | To change where Archestra stores the marketplace cache, see `ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR`. | The reference holds the default. Say why you would change it. |
| A whole "Managing Skills" page: permissions, ownership, versions, concurrent edits, trash, environments, usage. | *(page deleted; one line on the parent links environments)* | Nobody opens it on purpose. |
| Then paste the URL and pick that App in step 4. | When you import, pick that App under **Authentication & subpath**. | Step numbers go stale. |
| Claude Code, Codex, Cursor, Copilot CLI, OpenCode, and most other coding agents set themselves up. | Claude Code, Codex, Cursor, Copilot CLI, and OpenCode set themselves up. **Any Client:** copy the URL and a key. | Never claim more than the code does. |
| A deterministic renderer builds the script… The sources are `platform/backend/src/services/…` | *(cut)* | Internals. |
| *(a table of three link and approval lifetimes)* | Requests expire after ten minutes. *(where the reader hits it)* | One number, where it matters. |
| ## Overview<br>This page describes what the setup changes. | *(start with the first fact)* | Boilerplate. |
| Hooks need the [Code Sandbox](…) to run. | *(cut)* | The sandbox is on by default. A prerequisite that almost never fails only worries the reader. |
| ## Reports that write themselves: schedules | ## Scheduled Tasks | Benefit vs name. |
| The MCP Registry is your organization's list of MCP servers. | The MCP Registry is your organization's own list of approved MCP servers. … Nobody copies config files or passes secrets around. | Flat opener. Say why it matters. |
| Each tool call runs as a real account: the caller's own, or one your team shares. | When an agent uses a tool, it acts as a real account in that app. Ask an agent to open a GitHub issue with your account, and the issue shows your name. | Jargon ("caller"), no picture. Give a concrete example. |
| An agent or gateway in **All** tool mode gets them automatically. | Its gateway offers every tool the person can use. | An undefined product term. |
| ## Set Up the Cluster, then two env vars | With the quickstart or the Helm chart, there is nothing to set up. Then one bullet for everyone else. | Lead with the shortcut most readers take. |
| Four sections, one per log tab, each repeating "One row per…" | One table: Tab, One row per, Open a row for | A table, not four sections with the same shape. |
| Already signed in to Okta? Send that token. Two steps. | Adds when to use it, what it unlocks (per-person accounts and identity exchange), the three checks a token must pass, and how to debug a rejection | Over-cut. A hard topic needs its next questions answered. |
| Copy the endpoint from the gateway's **Connect** tab into your client. | On **Connect**, click **Customize setup** and pick the gateway under **Gateway**. | Document the product's guided path, not the mechanism. |
| Image not found? Check the image name and the pull secret. | A table: **Failed to start** → open **Logs**. **Starting**, for minutes → the image does not pull, or the cluster is full. | Troubleshoot by symptom. |

## Process

1. **Name the reader and the job** for yourself: who opens this page, and what they do next. If you cannot answer, the page should not exist in its current form.
2. **Use the product.** Walk the feature in the running app with a browser-automation tool. Docs describe what the software does, not what an old page said. If you cannot run the product, say so in your report. Never guess a button label or a menu path.
3. **Verify every claim** against the UI and the code. Never carry a claim over because the old page had it. For audits, follow [Audit and Validation](references/audit-and-validation.md).
4. **Choose and cut first.** Decide the one thing each section must say. Delete everything else. Then fill the gaps from "Too Little".
5. **Skim it like the reader.** Read only the headings and first lines. If that does not answer the reader's question, restructure.
6. **Refresh the screenshots** for every page you touch that shows the product. See [Site Mechanics](references/site-mechanics.md#screenshots).
7. **Get a hostile review** if a second reviewer is available. Fix every valid point. A reviewer that cannot see the code must never make a fact wrong. The user's direct decisions beat any reviewer. Give one line of reason for each rejected point in your report, never in the page.
8. **Validate** with the commands in [Audit and Validation](references/audit-and-validation.md). Report what passed, what you only inspected, and what you could not exercise.
