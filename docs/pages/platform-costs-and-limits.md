---
title: Costs & Limits
category: LLM Proxy
order: 2
---

Monitor and control AI model expenses with real-time tracking, spending limits, and automatic optimizations.

## Statistics

![Cost Statistics Dashboard](/docs/automated_screenshots/platform_cost_statistics.png)

Track usage and costs across teams, profiles, and models with time-based filtering (hour to 12 months).

**Key metrics:**
- Team costs with member/profile counts
- Individual profile usage
- Model breakdown by cost percentage
- Interactive charts for trend analysis

## Usage Limits

![Usage Limits Configuration](/docs/automated_screenshots/platform_cost_limits.png)

Set spending limits to prevent budget overruns:

**LLM Limits**
- Apply to organization, teams, or profiles
- Daily/monthly reset periods
- Actions when limit reached (block, alert, fallback)

**Auto-cleanup**
- Configure data retention (hourly to monthly)
- Keep costs database optimized

## Optimization Rules

![Optimization Rules](/docs/automated_screenshots/platform_cost_optimization.png)

Automatically switch to cheaper models based on conditions:

**Rule Types:**
- **Content Length** - Use cheaper models for short prompts (<500 tokens)
- **Tool Presence** - Simpler models when no tools required
- **Time-based** - Off-peak optimizations

Rules apply by priority order with configurable target models.

## Related Documentation

- [Profiles Configuration](platform-profiles)
- [Observability](platform-observability)
- [Deployment](platform-deployment)
