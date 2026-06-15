"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { LoadingWrapper } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useAppTools,
  useAssignToolToApp,
  useUnassignToolFromApp,
} from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useTools } from "@/lib/tools/tool.query";

// An app's assignable upstream tools. The App Data Store tools are always
// available to a running app and aren't listed here. Assignment uses dynamic
// credentials (resolved per-call), matching the safe default for shared apps.
export function AppToolsTab({ appId }: { appId: string }) {
  const { data: assigned, isPending } = useAppTools(appId);
  const { data: allTools } = useTools({});
  const { data: canEdit } = useHasPermissions({ app: ["update"] });
  const assignTool = useAssignToolToApp();
  const unassignTool = useUnassignToolFromApp();
  const [pickerOpen, setPickerOpen] = useState(false);

  const assignedIds = useMemo(
    () => new Set((assigned ?? []).map((t) => t.id)),
    [assigned],
  );
  // Candidates are upstream tools not yet assigned. Archestra built-ins (incl.
  // the App Data Store tools, already available to a running app) aren't
  // app-assignable, so drop the Archestra catalog.
  const candidates = useMemo(
    () =>
      (allTools ?? []).filter(
        (t) =>
          !assignedIds.has(t.id) && t.catalogId !== ARCHESTRA_MCP_CATALOG_ID,
      ),
    [allTools, assignedIds],
  );

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {canEdit ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="self-start">
              <Plus className="h-4 w-4" />
              Add tool
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[360px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search tools…" />
              <CommandList>
                <CommandEmpty>No tools found.</CommandEmpty>
                <CommandGroup>
                  {candidates.map((tool) => (
                    <CommandItem
                      key={tool.id}
                      value={tool.name}
                      onSelect={() => {
                        assignTool.mutate({
                          appId,
                          toolId: tool.id,
                          body: { credentialResolutionMode: "dynamic" },
                        });
                        setPickerOpen(false);
                      }}
                    >
                      <span className="truncate">{tool.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : null}

      <LoadingWrapper isPending={isPending && !assigned}>
        {!assigned || assigned.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tools assigned. The app can still use its data store.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {assigned.map((tool) => (
              <li
                key={tool.id}
                className="flex items-center justify-between gap-2 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {tool.name}
                  </div>
                  {tool.description ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {tool.description}
                    </div>
                  ) : null}
                </div>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${tool.name}`}
                    onClick={() =>
                      unassignTool.mutate({ appId, toolId: tool.id })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </LoadingWrapper>
    </div>
  );
}
