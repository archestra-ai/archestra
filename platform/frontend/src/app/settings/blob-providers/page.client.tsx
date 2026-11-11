"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type BlobProvider,
  deleteBlobProvider,
  testBlobProvider,
  useBlobProviders,
  useDeleteBlobProvider,
} from "@/lib/blob-provider.query";
import { reportBulkOutcome, runBulkAction } from "@/lib/bulk-action";
import { getApiErrorMessage } from "@/lib/utils/api";
import { useSetSettingsAction } from "../layout";
import { BlobProviderDialog } from "./_parts/blob-provider-dialog";
import {
  BlobProvidersTable,
  type BlobProviderTestResult,
} from "./_parts/blob-providers-table";

export default function BlobProvidersPageClient() {
  const setActionButton = useSetSettingsAction();
  const queryClient = useQueryClient();
  const { data: providers = [], isLoading } = useBlobProviders();
  const [editing, setEditing] = useState<BlobProvider | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<BlobProvider | null>(null);
  const remove = useDeleteBlobProvider();
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [testResults, setTestResults] = useState<
    Record<string, BlobProviderTestResult>
  >({});

  const openDialog = useCallback((provider: BlobProvider | null) => {
    setEditing(provider);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ organizationSettings: ["update"] }}
        size="sm"
        onClick={() => openDialog(null)}
      >
        <Plus className="h-4 w-4" />
        Add blob provider
      </PermissionButton>,
    );
    return () => setActionButton(null);
  }, [setActionButton, openDialog]);

  const runTests = useCallback(async (targets: readonly BlobProvider[]) => {
    const ids = targets.map((provider) => provider.id);
    setTestingIds((current) => new Set([...current, ...ids]));
    const record = (id: string, result: Omit<BlobProviderTestResult, "at">) =>
      setTestResults((current) => ({
        ...current,
        [id]: { ...result, at: new Date() },
      }));
    const outcome = await runBulkAction({
      items: targets,
      describe: (provider) => provider.name,
      run: async (provider) => {
        try {
          const result = await testBlobProvider(provider.id);
          record(provider.id, result);
          if (!result.success) throw new Error(result.message);
        } catch (error) {
          record(provider.id, {
            success: false,
            message: getApiErrorMessage(error),
          });
          throw error;
        } finally {
          setTestingIds((current) => {
            const next = new Set(current);
            next.delete(provider.id);
            return next;
          });
        }
      },
    });
    if (targets.length === 1) {
      const failure = outcome.failed[0];
      if (failure) {
        toast.error(`${targets[0].name}: connection failed`, {
          description: failure.error,
        });
      } else {
        toast.success(`${targets[0].name}: connection works`);
      }
      return;
    }
    reportBulkOutcome({
      outcome,
      verb: "Connected to",
      failureVerb: "connect to",
      failureParticiple: "reached",
      noun: "blob provider",
    });
  }, []);

  const bulkDelete = useCallback(
    async (targets: readonly BlobProvider[]) => {
      const outcome = await runBulkAction({
        items: targets,
        describe: (provider) => provider.name,
        run: (provider) => deleteBlobProvider(provider.id),
      });
      await queryClient.invalidateQueries({ queryKey: ["blob-providers"] });
      reportBulkOutcome({
        outcome,
        verb: "Deleted",
        failureVerb: "delete",
        noun: "blob provider",
      });
      return outcome;
    },
    [queryClient],
  );

  return (
    <div className="space-y-4">
      <BlobProvidersTable
        providers={providers}
        isLoading={isLoading}
        onEdit={openDialog}
        onDelete={setDeleting}
        onTest={runTests}
        onBulkDelete={bulkDelete}
        testingIds={testingIds}
        testResults={testResults}
      />
      <BlobProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={editing}
      />
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete blob provider"
        description={`Delete ${deleting?.name ?? "this provider"} and its stored credentials? Files already written stay in place.`}
        isPending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
        }}
      />
    </div>
  );
}
