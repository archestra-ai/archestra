---
title: Schedule Triggers
category: Platform
subcategory: Agent Triggers
order: 26
description: Run agents automatically on cron schedules, fixed intervals, or one-time deferred execution.
lastUpdated: 2026-03-27
---

# Schedule Triggers

Schedule triggers allow agents to run automatically without external events. Use them for periodic reports, data syncs, health checks, or any task that should happen on a recurring or deferred basis.

## How It Works

1. You create a schedule trigger and assign it to an agent
2. The system evaluates all enabled triggers every 60 seconds
3. When a trigger is due, it queues an execution task
4. The task queue executes the agent via the A2A pipeline with retry support
5. After execution, the next run time is computed and the trigger is updated

## Trigger Types

### Cron

Standard cron expressions for complex scheduling needs. Uses 5-field syntax: `minute hour day month weekday`.

Examples:
- `0 9 * * 1-5` — weekdays at 9:00 AM
- `*/30 * * * *` — every 30 minutes
- `0 0 1 * *` — first day of each month at midnight

### Interval

Fixed-interval execution in seconds (minimum 60s). The next execution is scheduled relative to when the previous execution completes.

### One-time

Single deferred execution at a specific timestamp. The trigger automatically disables itself after running.

## Setup

Navigate to **Agents > Triggers > Schedule** and click **Create Trigger**.

1. **Name** — a descriptive label for the trigger
2. **Agent** — the internal agent to execute
3. **Schedule Type** — cron, interval, or one-time
4. **Schedule Configuration** — the cron expression, interval duration, or target timestamp
5. **Message** (optional) — text sent to the agent as input when the schedule fires

## API

All endpoints require `agentTrigger` RBAC permissions.

### List triggers

```
GET /api/agent-schedule-triggers?agentId={agentId}
```

### Create trigger

```
POST /api/agent-schedule-triggers
Content-Type: application/json

{
  "agentId": "uuid",
  "name": "Daily report",
  "triggerType": "cron",
  "cronExpression": "0 9 * * *",
  "message": "Generate the daily report",
  "enabled": true
}
```

### Update trigger

```
PUT /api/agent-schedule-triggers/:id
```

### Enable / Disable

```
POST /api/agent-schedule-triggers/:id/enable
POST /api/agent-schedule-triggers/:id/disable
```

### Manual trigger

```
POST /api/agent-schedule-triggers/:id/trigger
```

Executes the agent immediately regardless of the schedule.

### Delete trigger

```
DELETE /api/agent-schedule-triggers/:id
```

## Execution Details

- Triggers are evaluated every 60 seconds by the `check_due_agent_schedules` periodic task
- Each execution has a 5-minute timeout
- Failed executions record the error on the trigger and still advance to the next scheduled time
- One-time triggers automatically disable after execution
- Deleting an agent cascades to delete all its schedule triggers
- The `schedule` interaction source appears in LLM proxy logs for observability

## Misfire Grace Period

Each trigger has a configurable `misfireGraceSeconds` (default: 300). If the system was down when a trigger was due, it will still fire if the current time is within the grace window of the missed execution time.
