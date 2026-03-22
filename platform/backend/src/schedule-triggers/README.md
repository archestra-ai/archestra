# Scheduled Agent Triggers

The Scheduled Agent Triggers system allows users to automate agent runs using various scheduling strategies (Cron, Interval, or One-time).

## Architecture

1. **Database-First Scheduling**: The source of truth for "due" triggers is the `agent_schedule_triggers.next_due_at` column.
2. **Periodic Tick**: A background worker runs every 60 seconds (`check_due_schedule_triggers`) to find due triggers.
3. **Transactional Claiming**: The scheduler uses `FOR UPDATE SKIP LOCKED` to atomically claim triggers and create run snapshots.
4. **Task Queue Execution**: Actual agent execution is offloaded to the standard Archestra task queue for reliable, asynchronous processing.
5. **Immutable Snapshots**: Every run stores a complete snapshot of the trigger's configuration (agent, message, actor) to ensure historical execution integrity.

## Schedule Types

- **Cron**: Standard 5-field cron expressions (e.g., `0 9 * * 1-5` for Weekdays at 9 AM).
- **Interval**: Fixed execution every X seconds. Includes drift-prevention logic.
- **One-time**: Executes exactly once at a specific timestamp and then disables itself.

## Identity & Permissions

- **Execution Identity**: Runs execute using the `actorUserId` stored on the trigger (usually the creator/updater).
- **Permissions**: Requires `agentTrigger:read`, `agentTrigger:create`, `agentTrigger:update`, or `agentTrigger:delete` permissions.
- **Organization Scope**: Triggers and runs are strictly scoped to the user's organization.

## API Usage

### Create a Cron Trigger
`POST /api/agent-schedule-triggers`
```json
{
  "agentId": "uuid",
  "name": "Daily Report",
  "messageTemplate": "Generate the daily summary",
  "scheduleKind": "cron",
  "cronExpression": "0 9 * * *",
  "timezone": "America/New_York"
}
```

### Get Stats
`GET /api/agent-schedule-triggers/stats`
Returns aggregated organizational health (enabled count, 24h failure count).

### Manual Run
`POST /api/agent-schedule-triggers/:id/run-now`
Immediately enqueues an execution and records the `initiatedByUserId` for audit.
