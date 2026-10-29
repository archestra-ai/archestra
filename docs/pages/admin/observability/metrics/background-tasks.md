---
title: Background Task Metrics
description: Look up task queue attempts, retries, duration, and scheduled runs.
order: 7
lastUpdated: 2026-10-28
---

Track queued work and scheduled task runs across worker processes.

## Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="task_queue_tasks_enqueued_total"></span>`task_queue_tasks_enqueued_total`, <span id="task_queue_tasks_completed_total"></span>`task_queue_tasks_completed_total` | `task_type` | Tasks queued and completed |
| <span id="task_queue_tasks_failed_total"></span>`task_queue_tasks_failed_total` | `task_type` | Failed attempts. The task may be retried. |
| <span id="task_queue_tasks_dead_total"></span>`task_queue_tasks_dead_total` | `task_type` | Tasks that ran out of retries |
| <span id="task_queue_task_duration_seconds"></span>`task_queue_task_duration_seconds` | `task_type` | Task duration |
| <span id="task_queue_active_tasks"></span>`task_queue_active_tasks` | `task_type` | Tasks running now |
| <span id="task_queue_stuck_tasks_reset_total"></span>`task_queue_stuck_tasks_reset_total` | | Stuck tasks returned to the queue |
| <span id="schedule_trigger_runs_total"></span>`schedule_trigger_runs_total` | `agent_name`, `status` | [Scheduled task](/docs/chat/projects#scheduled-tasks) runs: `success`, `failed`, or `cancelled` |

Common `task_type` values are `connector_sync`, `batch_embedding`, `permission_sync`, and `schedule_trigger_run_execute`.
