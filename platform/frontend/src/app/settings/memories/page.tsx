"use client";

import { Brain, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { LoadingWrapper } from "@/components/loading";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentMemory,
  type MemoryScopeType,
  type UpsertMemoryBody,
  useAgentMemories,
  useDeleteAgentMemory,
  useUpsertAgentMemory,
} from "@/lib/agent-memory.query";
import { useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";

type FormValues = {
  scopeType: MemoryScopeType;
  scopeId: string;
  key: string;
  value: string;
};

const SCOPE_LABELS: Record<MemoryScopeType, string> = {
  user: "User",
  team: "Team",
  org: "Organization",
};

const SCOPE_BADGE_VARIANT: Record<
  MemoryScopeType,
  "default" | "secondary" | "outline"
> = {
  user: "default",
  team: "secondary",
  org: "outline",
};

function MemoryRow({
  memory,
  onDelete,
}: {
  memory: AgentMemory;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <Badge variant={SCOPE_BADGE_VARIANT[memory.scopeType]}>
            {SCOPE_LABELS[memory.scopeType]}
          </Badge>
          <span className="font-mono text-sm font-medium">{memory.key}</span>
        </div>
        <p className="text-muted-foreground truncate text-sm">{memory.value}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-destructive shrink-0"
        onClick={() => onDelete(memory.id)}
        aria-label="Delete memory"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

export default function MemoriesSettingsPage() {
  const { data: memories = [], isPending } = useAgentMemories();
  const upsertMutation = useUpsertAgentMemory();
  const deleteMutation = useDeleteAgentMemory();
  const { data: organization } = useOrganization();
  const { data: session } = useSession();

  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const form = useForm<FormValues>({
    defaultValues: {
      scopeType: "user",
      scopeId: "",
      key: "",
      value: "",
    },
  });

  const scopeType = form.watch("scopeType");

  const handleAdd = form.handleSubmit(async (values) => {
    let scopeId = values.scopeId;
    if (values.scopeType === "org") {
      scopeId = organization?.id ?? "";
    } else if (values.scopeType === "user") {
      scopeId = session?.user?.id ?? values.scopeId;
    }
    const body: UpsertMemoryBody = {
      scopeType: values.scopeType,
      scopeId,
      key: values.key,
      value: values.value,
    };
    await upsertMutation.mutateAsync(body);
    setIsDialogOpen(false);
    form.reset();
  });

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
  };

  const userMemories = memories.filter((m) => m.scopeType === "user");
  const teamMemories = memories.filter((m) => m.scopeType === "team");
  const orgMemories = memories.filter((m) => m.scopeType === "org");

  return (
    <div className="space-y-6">
      <Card>
        <SettingsCardHeader
          title={
            <span className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Agent Memories
            </span>
          }
          description="Persistent facts injected into every agent conversation. Agents can reference these without you repeating them each session."
          action={
            <Button onClick={() => setIsDialogOpen(true)} size="sm">
              <Plus className="mr-1 h-4 w-4" />
              Add Memory
            </Button>
          }
        />
        <CardContent>
          <LoadingWrapper isLoading={isPending}>
            {memories.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                No memories yet. Add facts you want agents to always know.
              </p>
            ) : (
              <div className="space-y-6">
                {userMemories.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Your preferences</h3>
                    <div className="space-y-2">
                      {userMemories.map((m) => (
                        <MemoryRow
                          key={m.id}
                          memory={m}
                          onDelete={handleDelete}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {teamMemories.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Team conventions</h3>
                    <div className="space-y-2">
                      {teamMemories.map((m) => (
                        <MemoryRow
                          key={m.id}
                          memory={m}
                          onDelete={handleDelete}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {orgMemories.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">
                      Organization context
                    </h3>
                    <div className="space-y-2">
                      {orgMemories.map((m) => (
                        <MemoryRow
                          key={m.id}
                          memory={m}
                          onDelete={handleDelete}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </LoadingWrapper>
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Memory</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="scopeType">Scope</Label>
              <Select
                value={scopeType}
                onValueChange={(v) =>
                  form.setValue("scopeType", v as MemoryScopeType)
                }
              >
                <SelectTrigger id="scopeType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User — only you see this</SelectItem>
                  <SelectItem value="team">
                    Team — shared with a team
                  </SelectItem>
                  <SelectItem value="org">
                    Organization — visible to all agents
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {scopeType === "team" && (
              <div className="space-y-2">
                <Label htmlFor="scopeId">Team ID</Label>
                <Input
                  id="scopeId"
                  placeholder="Enter team ID"
                  {...form.register("scopeId", { required: true })}
                />
                <p className="text-muted-foreground text-xs">
                  Find team IDs in Settings → Teams.
                </p>
              </div>
            )}

            {scopeType === "user" && (
              <p className="text-muted-foreground text-xs">
                This memory will be scoped to your user account and injected
                whenever you chat.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="key">Key</Label>
              <Input
                id="key"
                placeholder="e.g. preferred_language"
                {...form.register("key", { required: true })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="value">Value</Label>
              <Textarea
                id="value"
                placeholder="e.g. Always respond in TypeScript, not JavaScript."
                rows={3}
                {...form.register("value", { required: true })}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsDialogOpen(false);
                  form.reset();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={upsertMutation.isPending}>
                {upsertMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
