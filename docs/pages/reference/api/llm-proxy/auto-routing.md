---
title: Auto Routing API
description: Manage auto routers, plans, dry-run previews, simulations, and historical backfill
order: 2
lastUpdated: 2026-11-19
---

<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Manage [Auto Routing](/docs/llm-proxy/auto-routing) routers, test prompts against active plans, simulate budget or traffic changes, and inspect routed usage.

- **Routers and state:** enable or disable auto routing for the organization and create, update, list, or delete routers.
- **Plans and usage:** list plan history, inspect a fitted plan, trigger an immediate replan, and read 7- or 14-day routed spend and savings.
- **Preview, simulation, and diagnostics:** dry-run an opening prompt or request body without calling a model (`/preview`), fit a what-if plan at another budget or traffic scale without publishing it (`/simulate`), or re-solve the fit history per session (`/diagnostics`).
- **Backfill:** scan and score historical proxy sessions for the default `auto` router.

To inspect the decision saved with a particular LLM Proxy request, use the [log auto-routing endpoint](/docs/reference/api/llm-proxy/logs#tag/llm-proxy-logs/GET/api/llm-proxy-logs/{logId}/auto-routing).
