/**
 * Form for creating / editing an agent schedule trigger.
 */

import React, { useState } from "react";
import type {
  CronTrigger,
  IntervalTrigger,
  ScheduleTrigger,
  CreateAgentSchedulePayload,
} from "../../../lib/agent-schedules/types";
import {
  isValidCronExpression,
  describeTrigger,
  getNextRunDate,
} from "../../../lib/agent-schedules/cron-utils";

interface ScheduleTriggerFormProps {
  agentId: string;
  /** Existing schedule being edited, if any */
  initialValues?: Partial<CreateAgentSchedulePayload>;
  onSubmit: (payload: CreateAgentSchedulePayload) => void | Promise<void>;
  onCancel?: () => void;
}

const INTERVAL_UNITS = ["minutes", "hours", "days"] as const;

const CRON_PRESETS: { label: string; expression: string }[] = [
  { label: "Every minute",      expression: "* * * * *" },
  { label: "Every 5 minutes",   expression: "*/5 * * * *" },
  { label: "Every 15 minutes",  expression: "*/15 * * * *" },
  { label: "Every 30 minutes",  expression: "*/30 * * * *" },
  { label: "Every hour",        expression: "0 * * * *" },
  { label: "Every day at 9 AM", expression: "0 9 * * *" },
  { label: "Weekdays at 9 AM",  expression: "0 9 * * 1-5" },
  { label: "Every Sunday",      expression: "0 0 * * 0" },
];

export function ScheduleTriggerForm({
  agentId,
  initialValues,
  onSubmit,
  onCancel,
}: ScheduleTriggerFormProps) {
  const initTrigger = initialValues?.trigger ?? {
    type: "interval",
    value: 60,
    unit: "minutes",
  } as IntervalTrigger;

  const [name, setName] = useState(initialValues?.name ?? "");
  const [triggerType, setTriggerType] = useState<"cron" | "interval">(initTrigger.type);

  // Interval state
  const initInterval = initTrigger.type === "interval" ? initTrigger : { value: 60, unit: "minutes" as const };
  const [intervalValue, setIntervalValue] = useState(initInterval.value);
  const [intervalUnit, setIntervalUnit] = useState<IntervalTrigger["unit"]>(initInterval.unit);

  // Cron state
  const initCron = initTrigger.type === "cron" ? initTrigger : { expression: "0 * * * *", timezone: "UTC" };
  const [cronExpression, setCronExpression] = useState(initCron.expression);
  const [cronTimezone, setCronTimezone] = useState(initCron.timezone ?? "UTC");

  const [submitting, setSubmitting] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);

  // Build the current trigger object
  const trigger: ScheduleTrigger =
    triggerType === "interval"
      ? { type: "interval", value: intervalValue, unit: intervalUnit }
      : { type: "cron", expression: cronExpression, timezone: cronTimezone };

  const nextRun = (() => {
    if (triggerType === "cron" && !isValidCronExpression(cronExpression)) return null;
    try {
      return getNextRunDate(trigger);
    } catch {
      return null;
    }
  })();

  const handleCronChange = (expr: string) => {
    setCronExpression(expr);
    setCronError(
      expr && !isValidCronExpression(expr) ? "Invalid cron expression" : null
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (triggerType === "cron" && !isValidCronExpression(cronExpression)) return;

    const payload: CreateAgentSchedulePayload = {
      agentId,
      name: name.trim(),
      trigger,
      status: initialValues?.status ?? "active",
      input: initialValues?.input,
    };

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="schedule-trigger-form">
      {/* Name */}
      <div className="form-field">
        <label htmlFor="schedule-name">Schedule name</label>
        <input
          id="schedule-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Daily digest"
          required
        />
      </div>

      {/* Trigger type */}
      <div className="form-field">
        <label>Trigger type</label>
        <div className="radio-group">
          <label>
            <input
              type="radio"
              name="triggerType"
              value="interval"
              checked={triggerType === "interval"}
              onChange={() => setTriggerType("interval")}
            />
            Interval
          </label>
          <label>
            <input
              type="radio"
              name="triggerType"
              value="cron"
              checked={triggerType === "cron"}
              onChange={() => setTriggerType("cron")}
            />
            Cron expression
          </label>
        </div>
      </div>

      {/* Interval inputs */}
      {triggerType === "interval" && (
        <div className="form-field interval-fields">
          <label>Run every</label>
          <div className="interval-row">
            <input
              type="number"
              min={1}
              value={intervalValue}
              onChange={(e) => setIntervalValue(Math.max(1, parseInt(e.target.value, 10) || 1))}
              style={{ width: "80px" }}
            />
            <select
              value={intervalUnit}
              onChange={(e) => setIntervalUnit(e.target.value as IntervalTrigger["unit"])}
            >
              {INTERVAL_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Cron inputs */}
      {triggerType === "cron" && (
        <>
          <div className="form-field">
            <label>Presets</label>
            <div className="cron-presets">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.expression}
                  type="button"
                  className={`preset-btn ${cronExpression === p.expression ? "active" : ""}`}
                  onClick={() => handleCronChange(p.expression)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="cron-expression">
              Cron expression{" "}
              <span className="hint">(minute hour dom month dow)</span>
            </label>
            <input
              id="cron-expression"
              type="text"
              value={cronExpression}
              onChange={(e) => handleCronChange(e.target.value)}
              placeholder="0 9 * * 1-5"
              className={cronError ? "input-error" : ""}
            />
            {cronError && <span className="error-text">{cronError}</span>}
          </div>

          <div className="form-field">
            <label htmlFor="cron-tz">Timezone</label>
            <input
              id="cron-tz"
              type="text"
              value={cronTimezone}
              onChange={(e) => setCronTimezone(e.target.value)}
              placeholder="UTC"
            />
          </div>
        </>
      )}

      {/* Preview */}
      {nextRun && (
        <div className="schedule-preview">
          <strong>{describeTrigger(trigger)}</strong>
          <br />
          Next run: {nextRun.toLocaleString()}
        </div>
      )}

      {/* Actions */}
      <div className="form-actions">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={
            submitting ||
            !name.trim() ||
            (triggerType === "cron" && !!cronError)
          }
        >
          {submitting ? "Saving…" : "Save schedule"}
        </button>
      </div>
    </form>
  );
}
