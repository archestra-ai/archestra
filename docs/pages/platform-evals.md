---
title: Evals (Beta)
category: Agents
order: 13
description: Test suites that grade an agent's answers against assertions
lastUpdated: 2026-08-25
---

![Eval suites](/docs/automated_screenshots/platform-evals_suites-list.webp)

Evals grade an agent against a fixed set of test cases. You write cases once, then run them after every prompt or tool change — so a regression shows up as a failed case, not a support ticket.

Go to **Evals** in the sidebar to create a suite.

## Suites and Cases

A suite is a named collection of cases. A case has one input message and a list of assertions. The agent gets the input as a normal chat message; its answer must satisfy every assertion for the case to pass.

Assertions come in seven types:

| Type | Passes when |
|---|---|
| Exact match | The output equals the expected text |
| Contains | The output contains all (or any) of the given values |
| Does not contain | The output contains none of the given values |
| Matches regex | The output matches the pattern |
| Tool was called | The agent called every named tool |
| Tool was not called | The agent called none of the named tools |
| LLM judge | A judge model decides the output meets your written criteria |

The LLM judge uses your organization's default model. It returns a pass or fail with a short reason, which appears in the run results.

![Suite detail](/docs/automated_screenshots/platform-evals_suite-detail.webp)

## Runs

Press **Run**, pick an agent, and optionally label the run — a CI build number, for example. The run executes in the background: each case is sent to the agent, graded, and recorded. Cases run one at a time, in order.

A run snapshots the suite's cases when it starts. Editing a case afterwards changes future runs, not the one in flight.

![Run results](/docs/automated_screenshots/platform-evals_run-results.webp)

The run page shows pass rate, token usage, and cost, plus a per-case breakdown. Expand a case to see the agent's answer, the tools it called, and each assertion's outcome. From there you can open the underlying LLM session logs.

Tools that require approval fail immediately during a run — there is nobody to approve them in a background execution.

## Running From CI

Everything on this page is also a REST API, so a pipeline can run a suite and gate on the result. Create a run with `POST /api/eval-suites/{id}/runs`, then poll `GET /api/eval-runs/{id}` until its status is terminal. See the [API reference](./platform-api-reference).

## Use Case

Freya maintains a support agent for a bicycle shop. She keeps a "Support answers" suite with twelve cases — one per common question. The refund case sends "How do I return my bike?" and asserts the answer contains "30 days", never mentions "no refunds", and an LLM judge confirms the tone is polite. After each prompt tweak she runs the suite against the staging agent and only promotes the change when all twelve pass.

## Beta Limitations

- Cases are single-turn: one input message, one answer.
- Tool assertions see the agent's own tool calls, not those of delegated sub-agents.
- The judge model is the organization default; per-suite judge models are not yet supported.
