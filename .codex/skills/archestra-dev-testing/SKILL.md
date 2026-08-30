---
name: archestra-dev-testing
description: Use when deciding whether a change needs a test and at which level — unit, backend route-level integration, MSW-backed frontend integration, or e2e — or when reviewing tests for the "fluff test" anti-pattern. Start here before archestra-dev-backend-tests or archestra-dev-e2e.
---

# What to test, and at which level

Run commands from `platform/` unless specifically instructed otherwise.

This skill answers *should this test exist, and where does it belong*. Once you
know the level, the mechanics live elsewhere:

- `archestra-dev-backend-tests` — backend mocking rules, vitest projects, DB fixtures.
- `archestra-dev-e2e` — Playwright fixtures, WireMock, selectors.
- `archestra-dev-frontend` — component/query-hook conventions.

## The one rule

**A test earns its place by being able to fail for a reason you'd want to hear about.**

CI time is a real budget. Every test runs on every push, forever, and every test
is code someone has to keep working during unrelated refactors. A test that can
only fail when someone edits the literal it is compared against costs that
budget and returns nothing.

Before writing a test, answer: *what plausible mistake does this catch?* If the
answer is "someone deliberately changing this exact line", don't write it. If
you cannot name the bug, there is no test to write.

## Pick the level

Prefer the cheapest level that can actually catch the bug — but do not push a
test *down* a level if that means mocking away the thing that would break.

### Route-level integration tests are the default (backend)

This is the level to favour. A test that drives a real Fastify route through
`app.inject` against the PGlite database exercises the schema, the auth
middleware, endpoint permissions, the model layer, and the audit record all at
once — the layers where bugs actually live.

```ts
const response = await app.inject({
  method: "POST",
  url: "/api/knowledge-bases",
  payload: { name: "Test KB" },
});
expect(response.statusCode).toBe(200);
expect(response.json().name).toBe("Test KB");
```

That assertion looks trivial in isolation, but it is not a fluff test: the value
made a round trip through validation, authorization, and persistence. Asserting
what came *back out* of a system is different from asserting what a literal
says.

Never mock the database. Use the `@/test` fixtures (`makeUser`, `makeOrganization`,
`makeAgent`, …) and real model calls.

### MSW-backed integration tests are the default (frontend)

The frontend equivalent: render the real component tree with a real
`QueryClient` and stub only the HTTP boundary with MSW. This covers the query
hooks, loading and error states, cache invalidation and the rendered result
together.

```ts
const server = setupServer(
  http.get(`${API_ORIGIN}/api/apps/:id`, () => HttpResponse.json(app)),
);
```

See `frontend/src/app/a/[appId]/page.client.test.tsx` for the established shape.

### Unit tests, for real logic

Good unit tests cover branching, parsing, ordering, arithmetic, and edge cases —
logic you can get wrong. `shouldShowStickyBoundaryIndicator` in
`frontend/src/components/chat/message-boundary-divider.test.tsx` is a good one:
a pure predicate with a genuine off-by-one boundary.

Reach for a unit test when the function has decisions in it. Not when it has
none.

### E2E tests, sparingly

E2E is the most expensive level: slow, flaky-prone, and delicate to maintain.
Add one only for a **happy path** through a flow that no cheaper level can
cover — a real browser against a real stack, or real Kubernetes behaviour.

Do not use e2e for error branches, permission matrices, validation messages, or
field-level behaviour. Those belong in route-level or MSW-backed integration
tests, where they run in milliseconds and fail legibly.

When a bug fix needs pinning, ask whether an integration test would catch the
same regression. It usually would.

## The fluff test anti-pattern

The trap, as it usually arrives: a change is made, a test "should" accompany it,
and the fastest test to write is one that restates the code. It passes
immediately, looks like diligence, and can never fail usefully.

The canonical shape — the assertion is the source, re-typed:

```tsx
// Never. This asserts that JSX assigns props.
const comp = <MyComponent thing={false} />;
expect(comp.props.thing).toBe(false);
```

### Concrete instances removed from this repo

Each of these shipped, ran on every CI build, and caught nothing:

**A literal field compared to its own literal.** Every knowledge-base connector
declares its own `type = "notion" as const`, and eight tests asserted exactly
that back:

```ts
// Removed — cannot fail unless someone edits the line above it.
it("has the correct type", () => {
  expect(new NotionConnector().type).toBe("notion");
});
```

`BaseConnector` types that field as `ConnectorType` and `registry.ts` keys by
it, so a rename is a compile error or a registry break — both louder than a
test.

**But check the claim before you lean on it.** The same suites also asserted
`expect(connector.supportsPermissionSync).toBe(true)`, which *looks* like the
identical pattern and is not. That field is a plain boolean: flipping it to
`false` compiles cleanly, and — verified by doing it — every one of the
connector's own tests still passes. Meanwhile five call sites gate real
behaviour on it, so the flip would silently stop permission syncing for that
source.

The fix was not to keep fifteen copies of the literal, and not to delete the
coverage either — it was to move it to the level where it has a consumer:

```ts
// One capability matrix, pinned where the scheduler actually reads it.
test("pins the connector types that implement permission sync", () => {
  expect(getPermissionSyncConnectorTypes().filter((t) => t !== "perforce").sort())
    .toEqual([...]);
});
```

`perforce` is excluded because it computes the flag from `isK8sConfigured()`.
The lesson generalises: *"the type system already covers this"* and *"the
neighbouring tests already cover this"* are both claims you can test in about
two minutes by breaking the code and running the suite. Do that before deleting
anything.

**Prop pass-through.** Asserting that a `className` prop reaches the element it
is spread onto tests JSX, not the component:

```tsx
// Removed — a property of the framework, not of this component.
it("applies custom className to combobox", () => {
  render(<SearchableMultiSelect className="my-custom-class" {...rest} />);
  expect(screen.getByRole("combobox")).toHaveClass("my-custom-class");
});
```

**Styling copied from the source.** Asserting a component's own utility classes
turns every restyle into a test edit while catching no user-visible bug:

```tsx
// Removed — the test is a copy of the className string in the component.
expect(status).toHaveClass("min-h-[calc(var(--visual-viewport-height,100dvh)-12rem)]");
expect(wrapper).toHaveClass("sm:w-[320px]");
```

**Assertions the type system already proves.** Not a removal, but the pattern
to watch for: `resourceLabels` is a `Record<Resource, string>`, so a bare
"every resource has a label" existence check cannot fail at runtime. Where a
type guarantees the shape, a test earns its place only by asserting what the
type cannot — an empty string, say, which is why
`shared/permission.types.test.ts` also checks length and category membership and
stays.

### Class names are not automatically fluff

The distinction is whether the class carries a contract or is just styling:

- **Keep**: `motion-reduce:animate-none` (an accessibility escape hatch),
  `secret-masked` (a secret is actually masked), a `relative` wrapper that a
  regression once broke by dropping (see `search-input.test.tsx`).
- **Drop**: `size-8`, `text-sm`, `sm:w-[320px]` — sizing and colour with no
  behaviour attached.

Prefer asserting the user-visible fact instead: role, accessible name, visible
text, enabled/disabled, what is on screen and what is not.

## Never leave a disabled test behind

A permanently skipped test is worse than no test: it reads as coverage, runs
never, and rots against the code it claims to describe. This repo had a
`describe.skip("AgentForm")` with no reason or link; when un-skipped, two of its
three tests passed — real coverage that had been off for months — and the third
no longer matched the component at all.

- Fix it, or delete it. If it must stay off, say why and link the tracking issue
  (`oauth-self-hosted.spec.ts` does this correctly).
- A `test.skip("...", () => {})` with an empty body is a comment. Write a
  comment.
- Conditional skips for genuine environment gates
  (`test.skip(!byosEnabled, "…")`) are fine — they are runtime guards, not dead
  code.

## Duplication: cheap and load-bearing vs. expensive and redundant

Repetition across files is not automatically waste. Weigh what it costs against
what it covers:

- **Keep** the twelve `"rejects an empty batch"` bulk-route tests. They all
  exercise one shared `BulkIdsSchema`, but each also pins that *its own* route
  wired that schema up, and each is one extra `app.inject` on an app the suite
  already built — microseconds.
- **Keep** the parallel team-scope suites for `mcp-oauth-clients` and
  `llm-oauth-clients`. Eleven of their test bodies are byte-identical, but they
  guard two independent authorization surfaces with separately-implemented
  scope sequencing; deleting either half would let a privilege-escalation bug
  through on one of them.
- **Remove** repetition that re-asserts a shared literal per instantiation with
  no per-instance wiring to prove — the connector flags above.

The question is never "is this duplicated" but "does the second copy have its
own way to fail".

## Checklist before adding a test

1. Name the bug it catches. Can't? Don't write it.
2. Could the type system, a schema, or the compiler already catch it? Then skip
   it, or narrow the test to the part they can't prove.
3. Pick the cheapest level that still exercises the risky part — but don't mock
   away the thing under test to get there.
4. Assert observable behaviour: responses, rendered output, persisted rows,
   emitted events. Not internal shape, not styling, not that a prop arrived.
5. E2E only for a happy path nothing cheaper can reach.
6. If it can't be made to pass, don't commit it skipped.
