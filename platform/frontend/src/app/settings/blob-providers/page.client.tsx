"use client";

import { S3_AUTH_METHOD_LABELS } from "@archestra/shared";
import { HardDrive, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type BlobProvider,
  useBlobProviders,
  useDeleteBlobProvider,
  useTestBlobProvider,
} from "@/lib/blob-provider.query";
import { useSetSettingsAction } from "../layout";
import { BlobProviderDialog } from "./_parts/blob-provider-dialog";

export default function BlobProvidersPageClient() {
  const setActionButton = useSetSettingsAction();
  const { data: providers = [], isLoading } = useBlobProviders();
  const [editing, setEditing] = useState<BlobProvider | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<BlobProvider | null>(null);
  const remove = useDeleteBlobProvider();
  const test = useTestBlobProvider();

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ organizationSettings: ["update"] }}
        size="sm"
        onClick={() => {
          setEditing(null);
          setDialogOpen(true);
        }}
      >
        <Plus className="h-4 w-4" />
        Add blob provider
      </PermissionButton>,
    );
    return () => setActionButton(null);
  }, [setActionButton]);

  return (
    <div className="space-y-4">
      {!isLoading && providers.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HardDrive />
            </EmptyMedia>
            <EmptyTitle>No blob providers yet</EmptyTitle>
            <EmptyDescription>
              Add an S3 (or S3-compatible) bucket to export data to.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <PermissionButton
              permissions={{ organizationSettings: ["update"] }}
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              Add blob provider
            </PermissionButton>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Authentication</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell className="font-medium">{provider.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {location(provider)}
                    {provider.config.endpoint && (
                      <span className="block text-muted-foreground">
                        {provider.config.endpoint}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {S3_AUTH_METHOD_LABELS[provider.config.authMethod]}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <PermissionButton
                        permissions={{ organizationSettings: ["update"] }}
                        variant="outline"
                        size="xs"
                        disabled={test.isPending}
                        onClick={() => test.mutate(provider.id)}
                      >
                        <Plug className="h-3.5 w-3.5" />
                        <span>
                          {test.isPending && test.variables === provider.id
                            ? "Testing…"
                            : "Test"}
                        </span>
                      </PermissionButton>
                      <PermissionButton
                        permissions={{ organizationSettings: ["update"] }}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${provider.name}`}
                        onClick={() => {
                          setEditing(provider);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </PermissionButton>
                      <PermissionButton
                        permissions={{ organizationSettings: ["update"] }}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${provider.name}`}
                        onClick={() => setDeleting(provider)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </PermissionButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <BlobProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={editing}
      />
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete blob provider"
        description={`Delete ${deleting?.name ?? "this provider"} and its stored credentials? Files already written stay in the bucket.`}
        isPending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
        }}
      />
    </div>
  );
}

function location(provider: BlobProvider): string {
  const { bucket, keyPrefix } = provider.config;
  return `s3://${bucket}${keyPrefix ? `/${keyPrefix}` : ""}/`;
}
