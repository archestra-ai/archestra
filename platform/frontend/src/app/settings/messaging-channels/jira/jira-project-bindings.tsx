"use client";

import {
  type archestraApiTypes,
  CHANNEL_INSTRUCTIONS_MAX_LENGTH,
} from "@archestra/shared";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import {
  useChatOpsBindings,
  useDeleteChatOpsBinding,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import {
  useCreateJiraChatOpsBinding,
  useJiraChatOpsProjects,
} from "@/lib/chatops/jira.query";

type JiraBot =
  archestraApiTypes.GetJiraChatOpsConfigResponses["200"]["bots"][number];
type Binding =
  archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number];

export function JiraProjectBindingForm({ botId }: { botId: string }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <ProjectForm botId={botId} onClose={() => setOpen(false)} />
  ) : (
    <Button
      size="sm"
      variant="outline"
      className="self-start"
      onClick={() => setOpen(true)}
    >
      Connect project
    </Button>
  );
}

export function JiraProjectBindings({
  bots,
  canEdit,
}: {
  bots: JiraBot[];
  canEdit: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Binding | null>(null);
  const [removing, setRemoving] = useState<Binding | null>(null);
  const remove = useDeleteChatOpsBinding();
  const bindings = useChatOpsBindings({
    provider: "jira",
    limit: 20,
    offset,
    sortBy: "channelName",
    sortDirection: "asc",
  });
  const { data: agents = [] } = useAgentOptionsByIds({
    ids: bots.map((bot) => bot.agentId),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>3. Project bindings</CardTitle>
        <CardDescription>
          The bot answers mentions in these projects. An issue's comments stay
          in one conversation. Use project instructions to scope the agent's
          work.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {bindings.isError ? (
          <QueryLoadError
            title="Could not load Jira project bindings"
            error={bindings.error}
            onRetry={() => void bindings.refetch()}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Jira bot → Agent</TableHead>
                <TableHead>Instructions</TableHead>
                {canEdit && (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.isLoading && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <span>Loading project bindings…</span>
                  </TableCell>
                </TableRow>
              )}
              {!bindings.isLoading && bindings.data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <span className="text-muted-foreground">
                      No connected projects. Connect a project from a Jira bot
                      above.
                    </span>
                  </TableCell>
                </TableRow>
              )}
              {bindings.data?.data.map((binding) => {
                const bot = bots.find((item) =>
                  binding.channelId.startsWith(`${item.id}:`),
                );
                const agent = agents.find(
                  (item) => item.id === binding.agentId,
                );
                return (
                  <TableRow key={binding.id}>
                    <TableCell className="font-medium">
                      {binding.channelName ?? binding.channelId}
                    </TableCell>
                    <TableCell>
                      {bot?.displayName ?? "Disconnected identity"} →{" "}
                      {agent?.name ?? binding.agentId}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">
                      {binding.channelInstructions || "No project instructions"}
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setEditing(binding)}
                          >
                            Edit instructions
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setRemoving(binding)}
                          >
                            Disconnect
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {(offset > 0 || bindings.data?.pagination.hasNext) && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0 || bindings.isFetching}
              onClick={() => setOffset((value) => Math.max(0, value - 20))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !bindings.data?.pagination.hasNext || bindings.isFetching
              }
              onClick={() => setOffset((value) => value + 20)}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>
      {editing && (
        <EditProjectInstructions
          binding={editing}
          onClose={() => setEditing(null)}
        />
      )}
      <DeleteConfirmDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Disconnect Jira project?"
        description="This bot will stop answering in the project. Jira issues and comments are kept."
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        isPending={remove.isPending}
        onConfirm={() => {
          if (removing)
            remove.mutate(removing.id, {
              onSuccess: (removed) => {
                if (removed) setRemoving(null);
              },
            });
        }}
      />
    </Card>
  );
}

function ProjectForm({
  botId,
  onClose,
}: {
  botId: string;
  onClose: () => void;
}) {
  const projects = useJiraChatOpsProjects(botId);
  const create = useCreateJiraChatOpsBinding(botId);
  const form = useForm({ defaultValues: { projectId: "", instructions: "" } });
  return (
    <form
      className="flex flex-col gap-3 border-t pt-4"
      onSubmit={form.handleSubmit((values) =>
        create.mutate(values, { onSuccess: onClose }),
      )}
    >
      {projects.isError ? (
        <QueryLoadError
          title="Could not load Jira projects"
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`jira-project-${botId}`}>Jira project</Label>
          <Controller
            name="projectId"
            control={form.control}
            rules={{ required: true }}
            render={({ field }) => (
              <SearchableSelect
                id={`jira-project-${botId}`}
                ariaLabel="Jira project"
                className="w-full"
                value={field.value}
                onValueChange={field.onChange}
                disabled={projects.isLoading}
                items={(projects.data ?? []).map((project) => ({
                  value: project.id,
                  label: `${project.key} · ${project.name}`,
                }))}
                placeholder={
                  projects.isLoading ? "Loading projects…" : "Choose a project…"
                }
                emptyMessage="No projects are accessible to this Jira identity"
              />
            )}
          />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`jira-instructions-${botId}`}>
          Project instructions (optional)
        </Label>
        <Textarea
          id={`jira-instructions-${botId}`}
          placeholder="What should this agent do in this project?"
          maxLength={CHANNEL_INSTRUCTIONS_MAX_LENGTH}
          {...form.register("instructions")}
        />
        <p className="text-xs text-muted-foreground">
          Saving an existing project binding replaces its instructions. Jira
          permissions and the agent's tool permissions still apply.
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={
            !form.watch("projectId") || create.isPending || projects.isError
          }
        >
          <span>{create.isPending ? "Saving…" : "Save project binding"}</span>
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditProjectInstructions({
  binding,
  onClose,
}: {
  binding: Binding;
  onClose: () => void;
}) {
  const update = useUpdateChatOpsBinding();
  const form = useForm({
    defaultValues: { instructions: binding.channelInstructions ?? "" },
  });
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Instructions for ${binding.channelName ?? "Jira project"}`}
      size="small"
      isDirty={form.formState.isDirty}
    >
      <DialogForm
        onSubmit={form.handleSubmit(({ instructions }) =>
          update.mutate(
            {
              id: binding.id,
              body: { channelInstructions: instructions || null },
            },
            {
              onSuccess: (saved) => {
                if (saved) onClose();
              },
            },
          ),
        )}
      >
        <DialogBody>
          <Label htmlFor="jira-edit-instructions">Project instructions</Label>
          <Textarea
            id="jira-edit-instructions"
            className="mt-2"
            maxLength={CHANNEL_INSTRUCTIONS_MAX_LENGTH}
            {...form.register("instructions")}
          />
        </DialogBody>
        <DialogStickyFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={update.isPending}>
            <span>{update.isPending ? "Saving…" : "Save instructions"}</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
