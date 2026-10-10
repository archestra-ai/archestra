# Exploration angles

The orchestrator composes each lane's charter as: **one area or flow × one role × 2–3 angles drawn from different groups below**. Draw at random and vary the combination from previous runs; `manifest.lanes` records what was used. Explorers may follow a better lead when one appears, as long as they record it.

This list is a seed, not a checklist. Add angles that paid off, and drop ones that keep producing nothing.

## Inputs
- Boundary values: empty, whitespace-only, 1 char, max+1, 10k+ chars, negative, zero, decimal, scientific notation, huge integers
- Character classes: unicode, emoji, RTL, zero-width, `<script>`, SQL/LIKE metacharacters (`%`, `_`, `'`), path separators, the tool separator `__`
- Case and whitespace variants of an existing name (duplicate detection)
- Pasting into fields with input masks or sanitizers: does the stored value match what the user sees?
- URL-like fields: `javascript:`, `file:`, loopback, link-local, internal service names, a missing scheme, ports outside 1–65535

## State and lifecycle
- Full CRUD round-trip, then reload: is every field persisted and shown back?
- Create, then rename or delete something it depends on: dangling references, stale counts, orphans
- Clone, duplicate, export/import: what is silently dropped?
- Soft delete and restore: do counts, relations and search agree?
- Two tabs or two roles editing the same entity; stale data after a mutation without reload
- Async or long-running operations: install, sync, generation. Look at the in-progress UI, failure UI and retry.

## Consistency
- The same number in two places: card vs detail, list vs filtered list, UI vs API, chart vs table
- The same concept under different names across pages: titles, tab titles, toasts, dialogs, docs links
- The same action with different confirmation or undo behaviour in different places
- Filters, sort and pagination: round-trip through the URL, refresh, back/forward, invalid params

## Errors
- Force failures: invalid ids in URLs, malformed query params, network aborts (`page.route` → abort or a 500), slow responses
- What reaches the user: a raw backend message, a stack trace, SQL, k8s objects, `[object Object]`, a misleading "check your connection"
- Partial failure: the UI says error but the mutation happened, or the UI says success but nothing happened

## Roles and permissions
- Walk the area as a low-privilege role: controls shown but forbidden, raw 403 toasts, infinite skeletons, blank sections
- Direct API calls as a low-privilege role on endpoints the UI hides; compare with what the UI implies
- Data visibility across users: ids from one user's entities used by another

## Presentation
- Every page in the variant matrix, especially dialogs and dropdowns (the crawl only sees initial page states)
- Long content inside fixed-width containers: names, labels, URLs, error messages
- Keyboard-only use: focus order, focus traps in dialogs, Escape and Enter behaviour, shortcuts
- Empty, loading and error states that are missing, identical across different pages, or misleading

## Security-flavoured (escalate with `category: security`)
- Server-side fetches of user-supplied URLs (SSRF): any feature where the backend fetches a URL the user typed
- Tokens, ids or secrets exposed in list endpoints, exports, error messages, URLs or logs pages
- Account and session flows (sign-up, invites, password reset, sessions) driven by the wrong identity
- Privilege changes: can a role grant itself or others more than it has?
