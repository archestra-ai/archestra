"use client";

import { ExternalLink, Pencil, Settings, Trash2, Wrench } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { AppDeleteDialog } from "@/app/apps/_parts/app-delete-dialog";
import { AppToolsEditor } from "@/app/apps/_parts/app-tools-editor";
import { EnvironmentSelector } from "@/components/environment-selector";
import { AppEditModelContextDialog } from "@/components/mcp-app/app-edit-model-context-dialog.lazy";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useApp,
  useAppTools,
  useAssignToolToApp,
  useUnassignToolFromApp,
  useUpdateApp,
} from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

// Identity fields are all the menu and its rename/delete dialogs need; the
// environment + assigned tools are fetched lazily when Manage tools opens. This
// minimal shape is shared by the full app (chat panel) and the gallery list item.
type App = { id: string; name: string; description: string | null };

type OpenDialog = "rename" | "tools" | "delete" | null;

// Settings menu for managing an owned app: optionally open it in a new tab,
// rename (name/description), manage its environment + enabled tools, or delete
// it. Each action opens its own dialog. The Manage tools dialog stages the
// environment behind Save/Cancel; its tool toggles persist live. Hidden when the
// caller can do none of the available actions.
export function AppSettingsMenu({
  app,
  trigger,
  openInNewTab = false,
}: {
  app: App;
  /** Overrides the default gear button (e.g. the gallery card's kebab). */
  trigger?: ReactNode;
  /** Adds an "Open in new tab" entry that opens the standalone run page. */
  openInNewTab?: boolean;
}) {
  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const toolsOpen = dialog === "tools";

  const updateApp = useUpdateApp();
  const assignTool = useAssignToolToApp();
  const unassignTool = useUnassignToolFromApp();
  // The full app (for its environment) and assigned tools are only needed while
  // the Manage tools dialog is open, so fetch them lazily to keep gallery cards
  // from each firing a detail request on mount.
  const { data: fullApp } = useApp(toolsOpen ? app.id : null);
  const { data: assignedTools } = useAppTools(toolsOpen ? app.id : null);

  // The Manage tools dialog stages both the environment and the tool selection,
  // then commits them as a pair on Save. Seed the staged values from server
  // state once the dialog opens and the lazy fetches land.
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    if (toolsOpen && fullApp) setEnvironmentId(fullApp.environmentId ?? null);
  }, [toolsOpen, fullApp]);
  useEffect(() => {
    if (toolsOpen && assignedTools) {
      setSelectedToolIds(new Set(assignedTools.map((t) => t.id)));
    }
  }, [toolsOpen, assignedTools]);

  // Cancel / dismiss discards the staged environment + tools (the effects above
  // re-seed on the next open).
  const closeTools = () => setDialog(null);

  const handleToolsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if ((environmentId ?? null) !== (fullApp?.environmentId ?? null)) {
      const result = await updateApp.mutateAsync({
        appId: app.id,
        body: { environmentId },
      });
      if (!result) return;
    }
    const current = new Set((assignedTools ?? []).map((t) => t.id));
    await Promise.all([
      ...[...selectedToolIds]
        .filter((id) => !current.has(id))
        .map((id) =>
          assignTool.mutateAsync({
            appId: app.id,
            toolId: id,
            body: { credentialResolutionMode: "dynamic" },
          }),
        ),
      ...[...current]
        .filter((id) => !selectedToolIds.has(id))
        .map((id) => unassignTool.mutateAsync({ appId: app.id, toolId: id })),
    ]);
    setDialog(null);
  };

  const savingTools =
    !fullApp ||
    updateApp.isPending ||
    assignTool.isPending ||
    unassignTool.isPending;

  if (!openInNewTab && !canUpdate && !canDelete) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              aria-label="App settings"
              title="App settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {openInNewTab && (
            <DropdownMenuItem
              onSelect={() =>
                window.open(`/a/${app.id}`, "_blank", "noopener,noreferrer")
              }
            >
              <ExternalLink />
              Open in new tab
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <>
              <DropdownMenuItem onSelect={() => setDialog("rename")}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("tools")}>
                <Wrench />
                Manage tools
              </DropdownMenuItem>
            </>
          )}
          {canDelete && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDialog("delete")}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "rename" && (
        <AppEditModelContextDialog
          app={app}
          open
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}

      <StandardFormDialog
        open={dialog === "tools"}
        onOpenChange={(open) => (open ? setDialog("tools") : closeTools())}
        onSubmit={handleToolsSubmit}
        title="Manage tools"
        description="Pick this app's environment and which MCP tools it can call."
        size="medium"
        footer={
          <>
            <Button type="button" variant="outline" onClick={closeTools}>
              Cancel
            </Button>
            <Button type="submit" disabled={savingTools}>
              {savingTools ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-6">
          <EnvironmentSelector
            value={environmentId}
            onChange={setEnvironmentId}
            helpText="The app can only be assigned and call MCP tools in this environment."
          />
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Tools</h3>
            <AppToolsEditor
              appId={app.id}
              environmentId={environmentId}
              selectedToolIds={selectedToolIds}
              onSelectionChange={setSelectedToolIds}
            />
          </div>
        </div>
      </StandardFormDialog>

      <AppDeleteDialog
        app={app}
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
      />
    </>
  );
}
