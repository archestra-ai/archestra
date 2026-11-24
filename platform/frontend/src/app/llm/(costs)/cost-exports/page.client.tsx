"use client";

import type { Permissions } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BlobProviderDialog } from "@/app/settings/blob-providers/_parts/blob-provider-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type BlobProvider, useBlobProviders } from "@/lib/blob-provider.query";
import { reportBulkOutcome, runBulkAction } from "@/lib/bulk-action";
import {
  type CostExport,
  costExportKeys,
  deleteCostExport,
  setCostExportEnabled,
  useCostExports,
  useDeleteCostExport,
  useRunCostExport,
} from "@/lib/cost-export.query";
import { useSetCostsAction } from "../layout";
import { configureStep } from "./_parts/configure-step";
import { CostExportDialog } from "./_parts/cost-export-dialog";
import { CostExportsFirstUse } from "./_parts/cost-exports-first-use";
import { CostExportsTable } from "./_parts/cost-exports-table";

const EDIT: Permissions = {
  costExport: ["create"],
  llmCost: ["read"],
};
const ADD_PROVIDER: Permissions = { organizationSettings: ["update"] };

export default function CostExportsPageClient() {
  const setActionButton = useSetCostsAction();
  const queryClient = useQueryClient();
  const { data: exports = [], isLoading, isSuccess } = useCostExports();
  const { data: providers = [], isSuccess: providersLoaded } =
    useBlobProviders();
  const schedulePermission = useHasPermissions(EDIT);
  const addProviderPermission = useHasPermissions(ADD_PROVIDER);
  // What Configure opens while there is no export yet: the first step that
  // is still missing.
  const step = configureStep({
    canSchedule: schedulePermission.isPending
      ? undefined
      : schedulePermission.data,
    canAddProvider: addProviderPermission.isPending
      ? undefined
      : addProviderPermission.data,
    providerCount: providersLoaded ? providers.length : undefined,
  });
  const [editing, setEditing] = useState<CostExport | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<BlobProvider | null>(
    null,
  );
  const [deleting, setDeleting] = useState<CostExport | null>(null);
  const remove = useDeleteCostExport();
  const run = useRunCostExport();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [initialProviderId, setInitialProviderId] = useState<string | null>(
    null,
  );

  // `?new=1&blobProviderId=…` (from a blob provider's row menu) opens the
  // schedule dialog with that destination picked, then drops the params.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    setInitialProviderId(searchParams.get("blobProviderId"));
    setEditing(null);
    setDialogOpen(true);
    router.replace("/llm/cost-exports", { scroll: false });
  }, [searchParams, router]);

  // The header button appears with the first export. Before that the page
  // has one way in, Configure, which also covers a missing blob provider.
  const hasExports = exports.length > 0;
  useEffect(() => {
    setActionButton(
      hasExports ? (
        <PermissionButton
          permissions={EDIT}
          size="sm"
          onClick={() => {
            setEditing(null);
            setInitialProviderId(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Schedule export
        </PermissionButton>
      ) : null,
    );
    return () => setActionButton(null);
  }, [setActionButton, hasExports]);

  return (
    // Same offset as the Limits tab: the filters sit right under the tabs.
    <div className="-mt-3">
      <CostExportsTable
        exports={exports}
        providers={providers}
        isLoading={isLoading}
        isLoaded={isSuccess}
        firstUse={
          // Undoes the offset above: there are no filters to pull up.
          <div className="pt-3">
            <CostExportsFirstUse
              step={step}
              onConfigure={() => {
                if (step === "add-provider") {
                  // Saving the provider opens the schedule dialog with it.
                  setEditingProvider(null);
                  setProviderDialogOpen(true);
                  return;
                }
                setEditing(null);
                setInitialProviderId(null);
                setDialogOpen(true);
              }}
            />
          </div>
        }
        onEdit={(costExport) => {
          setEditing(costExport);
          setDialogOpen(true);
        }}
        onDelete={setDeleting}
        onRun={(costExport) => run.mutate(costExport.id)}
        runningId={run.isPending ? (run.variables ?? null) : null}
        onEditProvider={(provider) => {
          setEditingProvider(provider);
          setProviderDialogOpen(true);
        }}
        onBulkSetEnabled={async (targets, enabled) => {
          const outcome = await runBulkAction({
            items: targets,
            describe: (costExport) => costExport.name,
            run: (costExport) =>
              setCostExportEnabled({ id: costExport.id, enabled }),
          });
          await queryClient.invalidateQueries({
            queryKey: costExportKeys.all,
          });
          reportBulkOutcome({
            outcome,
            verb: enabled ? "Resumed" : "Paused",
            failureVerb: enabled ? "resume" : "pause",
            noun: "cost export",
          });
          return outcome;
        }}
        onBulkDelete={async (targets) => {
          const outcome = await runBulkAction({
            items: targets,
            describe: (costExport) => costExport.name,
            run: (costExport) => deleteCostExport(costExport.id),
          });
          await queryClient.invalidateQueries({
            queryKey: costExportKeys.all,
          });
          reportBulkOutcome({
            outcome,
            verb: "Deleted",
            failureVerb: "delete",
            noun: "cost export",
          });
          return outcome;
        }}
      />
      <BlobProviderDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        provider={editingProvider}
        onSaved={(saved) => {
          // A fixed destination: the next tick (or Retry) picks it up.
          if (editingProvider) return;
          // Straight on to the export, with the new destination picked.
          setEditing(null);
          setInitialProviderId(saved.id);
          setDialogOpen(true);
        }}
      />
      <CostExportDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        costExport={editing}
        initialBlobProviderId={initialProviderId}
        onAddProvider={() => {
          setDialogOpen(false);
          setEditingProvider(null);
          setProviderDialogOpen(true);
        }}
      />
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete cost export"
        description={`Stop ${deleting?.name ?? "this export"}? Files already written stay in the bucket.`}
        isPending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
        }}
      />
    </div>
  );
}
