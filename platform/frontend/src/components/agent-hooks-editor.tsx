"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { ChevronRight, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { forwardRef, useId, useImperativeHandle, useState } from "react";
import { toast } from "sonner";
import { Editor } from "@/components/editor";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  generateHookFileName,
  type HookLanguage,
  languageFromFileName,
} from "@/lib/agent-hooks-editor.file-name";
import { parseRequirementsInput } from "@/lib/agent-hooks-editor.requirements";
import { useFeature } from "@/lib/config/config.query";
import {
  type AgentHook,
  createHooksForAgent,
  type HookEvent,
  useAgentHooks,
  useCreateHook,
  useDeleteHook,
  useUpdateHook,
} from "@/lib/hook.query";
import { generateUuid } from "@/lib/uuid";

export interface AgentHooksEditorRef {
  /**
   * Create-mode only: persist hooks staged before the agent existed against
   * the newly created agent. Throws on failure so the caller's create rollback
   * (delete the just-created agent) kicks in, matching the tools editor.
   */
  saveChanges: (params: { agentId: string }) => Promise<void>;
}

interface AgentHooksEditorProps {
  /** Absent in the agent create form; hooks are staged locally until save. */
  agentId?: string;
}

export const AgentHooksEditor = forwardRef<
  AgentHooksEditorRef,
  AgentHooksEditorProps
>(function AgentHooksEditor({ agentId }, ref) {
  const sandboxEnabled = useFeature("sandbox");

  // Hooks only execute when the sandbox runtime is enabled; hide the editor
  // entirely otherwise. Gate before mounting the inner component so its data
  // and mutation queries don't run when the feature is off.
  if (!sandboxEnabled) {
    return null;
  }

  return <AgentHooksEditorContent agentId={agentId} ref={ref} />;
});

// === Internal ===

const HOOK_EVENTS: { value: HookEvent; label: string }[] = [
  { value: "session_start", label: "Session start" },
  { value: "pre_tool_use", label: "Pre tool use" },
  { value: "post_tool_use", label: "Post tool use" },
];

const EVENT_LABELS: Record<HookEvent, string> = Object.fromEntries(
  HOOK_EVENTS.map((e) => [e.value, e.label]),
) as Record<HookEvent, string>;

/**
 * Starter scripts pre-filled for new hooks: read the JSON payload from stdin
 * and point at the context reference right above the editor.
 */
const STARTER_SCRIPTS: Record<HookLanguage, string> = {
  python: `import json
import sys

payload = json.load(sys.stdin)

# See "Available context" above for the fields this event receives.
# Exit 0 to proceed; print to stdout/stderr depending on the event's contract.
`,
  shell: `payload=$(cat)

# See "Available context" above for the fields this event receives.
# Exit 0 to proceed; print to stdout/stderr depending on the event's contract.
`,
};

/**
 * Per-event reference for the JSON payload a hook script receives on stdin
 * and what its exit code / output do. Field names intentionally match Claude
 * Code's hook payloads so existing scripts port unchanged; keep in sync with
 * `hook-dispatcher-service.ts` and the fire sites in the chat route / tool
 * builder.
 */
const COMMON_CONTEXT_FIELDS: { name: string; description: string }[] = [
  { name: "hook_event_name", description: 'Event name, e.g. "SessionStart"' },
  { name: "session_id", description: "The conversation ID" },
  { name: "cwd", description: "Sandbox working directory (/home/sandbox)" },
  { name: "permission_mode", description: 'Always "default"' },
];

const EVENT_CONTEXT: Record<
  HookEvent,
  {
    summary: string;
    fields: { name: string; description: string }[];
    example: string;
  }
> = {
  session_start: {
    summary:
      "Fires when a conversation starts. Cannot block: on exit 0, stdout is injected into the agent's context (appended to the system prompt).",
    fields: [
      { name: "source", description: 'Always "startup"' },
      { name: "model", description: "The model the session starts with" },
    ],
    example: `{
  "hook_event_name": "SessionStart",
  "session_id": "1f3b…",
  "cwd": "/home/sandbox",
  "permission_mode": "default",
  "source": "startup",
  "model": "claude-sonnet-5"
}`,
  },
  pre_tool_use: {
    summary:
      "Fires before every tool call. Exit 2 blocks the call — stderr becomes the reason shown to the model. Exit 0 proceeds.",
    fields: [
      { name: "tool_name", description: "Name of the tool about to run" },
      { name: "tool_input", description: "The tool's arguments (object)" },
    ],
    example: `{
  "hook_event_name": "PreToolUse",
  "session_id": "1f3b…",
  "cwd": "/home/sandbox",
  "permission_mode": "default",
  "tool_name": "slack__send_message",
  "tool_input": { "channel": "#general", "text": "…" }
}`,
  },
  post_tool_use: {
    summary:
      "Fires after every tool call. Exit 2 appends stderr to the tool result as [hook feedback] for the model. Exit 0 proceeds.",
    fields: [
      { name: "tool_name", description: "Name of the tool that ran" },
      { name: "tool_input", description: "The tool's arguments (object)" },
      {
        name: "tool_response",
        description: "The tool's output (string, truncated to 50,000 chars)",
      },
    ],
    example: `{
  "hook_event_name": "PostToolUse",
  "session_id": "1f3b…",
  "cwd": "/home/sandbox",
  "permission_mode": "default",
  "tool_name": "slack__send_message",
  "tool_input": { "channel": "#general", "text": "…" },
  "tool_response": "Message sent"
}`,
  },
};

/** A hook staged locally in create mode, before the agent exists. */
interface PendingHook {
  localId: string;
  event: HookEvent;
  fileName: string;
  content: string;
  requirements: string[];
  enabled: boolean;
}

/** Unified row shape for saved (edit mode) and pending (create mode) hooks. */
interface HookRow {
  key: string;
  event: HookEvent;
  fileName: string;
  content: string;
  requirements: string[];
  enabled: boolean;
}

interface HookFormValues {
  event: HookEvent;
  language: HookLanguage;
  content: string;
  requirements: string[];
}

type EditorPanelState = { mode: "add" } | { mode: "edit"; row: HookRow } | null;

const AgentHooksEditorContent = forwardRef<
  AgentHooksEditorRef,
  AgentHooksEditorProps
>(function AgentHooksEditorContent({ agentId }, ref) {
  const isPersisted = !!agentId;
  const { data: savedHooks = [], isLoading } = useAgentHooks(agentId);
  const createHook = useCreateHook(agentId ?? "");
  const updateHook = useUpdateHook(agentId ?? "");
  const deleteHook = useDeleteHook(agentId ?? "");

  const [pendingHooks, setPendingHooks] = useState<PendingHook[]>([]);
  const [panel, setPanel] = useState<EditorPanelState>(null);

  useImperativeHandle(
    ref,
    () => ({
      saveChanges: async ({ agentId: createdAgentId }) => {
        if (pendingHooks.length === 0) {
          return;
        }
        await createHooksForAgent(
          createdAgentId,
          pendingHooks.map(
            ({ event, fileName, content, requirements, enabled }) => ({
              event,
              fileName,
              content,
              requirements,
              enabled,
            }),
          ),
        );
      },
    }),
    [pendingHooks],
  );

  const rows: HookRow[] = isPersisted
    ? savedHooks.map((hook: AgentHook) => ({
        key: hook.id,
        event: hook.event,
        fileName: hook.fileName,
        content: hook.content,
        requirements: hook.requirements,
        enabled: hook.enabled,
      }))
    : pendingHooks.map((hook) => ({
        key: hook.localId,
        event: hook.event,
        fileName: hook.fileName,
        content: hook.content,
        requirements: hook.requirements,
        enabled: hook.enabled,
      }));

  const isMutating =
    createHook.isPending || updateHook.isPending || deleteHook.isPending;

  const handleSave = async (values: HookFormValues) => {
    const editedKey = panel?.mode === "edit" ? panel.row.key : null;
    const sameEventFileNames = rows
      .filter((r) => r.event === values.event && r.key !== editedKey)
      .map((r) => r.fileName);

    if (panel?.mode === "edit") {
      const previous = panel.row;
      // Keep the stored file name unless the event or language changed, so a
      // rename (which is also the execution-order key) only happens when it
      // has to.
      const fileName =
        previous.event === values.event &&
        languageFromFileName(previous.fileName) === values.language
          ? previous.fileName
          : generateHookFileName({
              event: values.event,
              language: values.language,
              takenFileNames: sameEventFileNames,
            });

      if (isPersisted) {
        const updated = await updateHook.mutateAsync({
          id: previous.key,
          event: values.event,
          fileName,
          content: values.content,
          requirements: values.language === "python" ? values.requirements : [],
        });
        if (!updated) {
          return;
        }
      } else {
        setPendingHooks((hooks) =>
          hooks.map((hook) =>
            hook.localId === previous.key
              ? {
                  ...hook,
                  event: values.event,
                  fileName,
                  content: values.content,
                  requirements:
                    values.language === "python" ? values.requirements : [],
                }
              : hook,
          ),
        );
      }
    } else {
      const fileName = generateHookFileName({
        event: values.event,
        language: values.language,
        takenFileNames: sameEventFileNames,
      });

      if (isPersisted) {
        const created = await createHook.mutateAsync({
          agentId,
          event: values.event,
          fileName,
          content: values.content,
          requirements: values.language === "python" ? values.requirements : [],
        });
        if (!created) {
          return;
        }
      } else {
        setPendingHooks((hooks) => [
          ...hooks,
          {
            localId: generateUuid(),
            event: values.event,
            fileName,
            content: values.content,
            requirements:
              values.language === "python" ? values.requirements : [],
            enabled: true,
          },
        ]);
      }
    }
    setPanel(null);
  };

  const handleToggleEnabled = (row: HookRow, enabled: boolean) => {
    if (isPersisted) {
      updateHook.mutate({ id: row.key, enabled });
    } else {
      setPendingHooks((hooks) =>
        hooks.map((hook) =>
          hook.localId === row.key ? { ...hook, enabled } : hook,
        ),
      );
    }
  };

  const handleDelete = (row: HookRow) => {
    if (panel?.mode === "edit" && panel.row.key === row.key) {
      setPanel(null);
    }
    if (isPersisted) {
      deleteHook.mutate(row.key);
    } else {
      setPendingHooks((hooks) =>
        hooks.filter((hook) => hook.localId !== row.key),
      );
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Hooks ({rows.length})</h3>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              Beta
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Run a script in the sandbox when a lifecycle event fires.{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformAgentHooks)}
              className="underline"
              showIcon={false}
            >
              Learn more
            </ExternalDocsLink>
          </p>
        </div>
        {panel === null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPanel({ mode: "add" })}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add hook
          </Button>
        )}
      </div>

      {isPersisted && isLoading ? (
        <p className="text-xs text-muted-foreground">Loading hooks...</p>
      ) : rows.length === 0 && panel === null ? (
        <p className="text-xs text-muted-foreground">No hooks yet.</p>
      ) : (
        rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex items-center gap-3 rounded-md border p-3"
              >
                <Badge variant="secondary">{EVENT_LABELS[row.event]}</Badge>
                <code className="flex-1 truncate text-xs">{row.fileName}</code>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => setPanel({ mode: "edit", row })}
                    aria-label={`Edit ${row.fileName}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Switch
                    checked={row.enabled}
                    disabled={updateHook.isPending}
                    onCheckedChange={(checked) =>
                      handleToggleEnabled(row, checked)
                    }
                    aria-label={`Toggle ${row.fileName}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    disabled={deleteHook.isPending}
                    onClick={() => handleDelete(row)}
                    aria-label={`Delete ${row.fileName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {panel !== null && (
        <HookEditorPanel
          key={panel.mode === "edit" ? panel.row.key : "add"}
          initial={panel.mode === "edit" ? panel.row : null}
          saving={isMutating}
          onCancel={() => setPanel(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
});

/**
 * Inline add/edit form rendered inside the hooks card — deliberately not a
 * nested dialog (the agent form is already a dialog). Monaco edits the script;
 * the language picker decides the interpreter (.py vs .sh) and the file name
 * is derived automatically.
 */
function HookEditorPanel({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: HookRow | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (values: HookFormValues) => Promise<void> | void;
}) {
  const fieldId = useId();
  const [event, setEvent] = useState<HookEvent>(
    initial?.event ?? "session_start",
  );
  const [language, setLanguage] = useState<HookLanguage>(
    initial ? languageFromFileName(initial.fileName) : "python",
  );
  const [content, setContent] = useState(
    initial?.content ?? STARTER_SCRIPTS.python,
  );
  const [requirements, setRequirements] = useState(
    initial?.requirements.join("\n") ?? "",
  );

  const handleLanguageChange = (next: HookLanguage) => {
    // Swap the starter template along with the language as long as the user
    // hasn't started writing their own script.
    if (!initial && content === STARTER_SCRIPTS[language]) {
      setContent(STARTER_SCRIPTS[next]);
    }
    setLanguage(next);
  };

  const handleSubmit = async () => {
    if (!content.trim()) {
      toast.error("Script content is required");
      return;
    }
    await onSave({
      event,
      language,
      content,
      requirements:
        language === "python" ? parseRequirementsInput(requirements) : [],
    });
  };

  const context = EVENT_CONTEXT[event];

  return (
    <div className="rounded-md border bg-background/50 p-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-event`}>Event</Label>
          <Select
            value={event}
            onValueChange={(value) => setEvent(value as HookEvent)}
          >
            <SelectTrigger id={`${fieldId}-event`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOOK_EVENTS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-language`}>Language</Label>
          <Select value={language} onValueChange={handleLanguageChange}>
            <SelectTrigger id={`${fieldId}-language`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="python">Python</SelectItem>
              <SelectItem value="shell">Shell</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
          Available context
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
            <p className="text-muted-foreground">{context.summary}</p>
            <p className="text-muted-foreground">
              The script receives one JSON object on stdin. Scripts time out
              after 30 seconds; failures never break the conversation.
            </p>
            <ul className="space-y-1">
              {[...COMMON_CONTEXT_FIELDS, ...context.fields].map((field) => (
                <li key={field.name} className="flex gap-2">
                  <code className="shrink-0 font-semibold">{field.name}</code>
                  <span className="text-muted-foreground">
                    {field.description}
                  </span>
                </li>
              ))}
            </ul>
            <pre className="overflow-x-auto rounded bg-muted p-2 font-mono">
              {context.example}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="space-y-2">
        <Label>Script</Label>
        <div className="overflow-hidden rounded-md border">
          <Editor
            height="220px"
            language={language === "python" ? "python" : "shell"}
            value={content}
            onChange={(value) => setContent(value || "")}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
              tabSize: language === "python" ? 4 : 2,
              // Monaco's EditContext-based input breaks inside a Radix Dialog
              // portal; fall back to the classic hidden textarea input.
              editContext: false,
            }}
          />
        </div>
      </div>

      {language === "python" && (
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-requirements`}>Requirements</Label>
          <Textarea
            id={`${fieldId}-requirements`}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder="One per line or comma-separated, e.g. requests, httpx"
            className="min-h-[60px] font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Python dependencies installed before the hook runs.
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSubmit}
          disabled={saving}
        >
          {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {initial ? "Save hook" : "Add hook"}
        </Button>
      </div>
    </div>
  );
}
