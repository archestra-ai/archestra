"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Edit, Plus, Trash2 } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useDeleteSsoProvider,
  useSsoProviders,
} from "@/lib/sso-provider.query";
import { CreateSsoProviderDialog } from "./_parts/create-sso-provider-dialog";
import { EditSsoProviderDialog } from "./_parts/edit-sso-provider-dialog";

type SsoProvider = NonNullable<
  ReturnType<typeof useSsoProviders>["data"]
>[number];

function SsoProvidersSettingsContent() {
  const { data: ssoProviders = [], isLoading } = useSsoProviders();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<SsoProvider | null>(
    null,
  );
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(
    null,
  );

  const columns: ColumnDef<SsoProvider>[] = [
    {
      accessorKey: "providerId",
      header: "Provider ID",
      cell: ({ row }) => (
        <div className="font-medium">{row.original.providerId}</div>
      ),
    },
    {
      accessorKey: "issuer",
      header: "Issuer",
      cell: ({ row }) => (
        <div className="font-mono text-sm">{row.original.issuer}</div>
      ),
    },
    {
      accessorKey: "domain",
      header: "Domain",
      cell: ({ row }) => (
        <div className="font-mono text-sm">{row.original.domain}</div>
      ),
    },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) => {
        const hasOidc = !!row.original.oidcConfig;
        const hasSaml = !!row.original.samlConfig;
        return (
          <div className="flex gap-1">
            {hasOidc && (
              <Badge variant="secondary" className="text-xs">
                OIDC
              </Badge>
            )}
            {hasSaml && (
              <Badge variant="secondary" className="text-xs">
                SAML
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      size: 120,
      enableHiding: false,
      cell: ({ row }) => {
        const provider = row.original;
        return (
          <div className="flex items-center gap-2">
            <PermissionButton
              permissions={{ ssoProvider: ["update"] }}
              variant="outline"
              size="icon-sm"
              onClick={() => setEditingProvider(provider)}
              tooltip="Edit Provider"
            >
              <Edit className="h-4 w-4" />
            </PermissionButton>
            <PermissionButton
              permissions={{ ssoProvider: ["delete"] }}
              variant="outline"
              size="icon-sm"
              onClick={() => setDeletingProviderId(provider.id)}
              tooltip="Delete Provider"
            >
              <Trash2 className="h-4 w-4" />
            </PermissionButton>
          </div>
        );
      },
    },
  ];

  if (isLoading) return <LoadingSpinner />;

  return (
    <PageLayout
      title="SSO Providers"
      description="Manage Single Sign-On (SSO) providers for your organization. Configure OIDC and SAML providers to enable seamless authentication."
      actionButton={
        <PermissionButton
          permissions={{ ssoProvider: ["create"] }}
          onClick={() => setIsCreateDialogOpen(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add SSO Provider
        </PermissionButton>
      }
    >
      <div className="w-full h-full">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
          {!ssoProviders || ssoProviders.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-muted-foreground">
                No SSO providers configured yet.
              </div>
              <div className="text-sm text-muted-foreground mt-2">
                Add your first SSO provider to enable single sign-on for your
                organization.
              </div>
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={ssoProviders}
              manualSorting={false}
              manualPagination={false}
            />
          )}

          <CreateSsoProviderDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          />

          {editingProvider && (
            <EditSsoProviderDialog
              provider={editingProvider}
              open={!!editingProvider}
              onOpenChange={(open) => !open && setEditingProvider(null)}
            />
          )}

          {deletingProviderId && (
            <DeleteSsoProviderDialog
              providerId={deletingProviderId}
              open={!!deletingProviderId}
              onOpenChange={(open) => !open && setDeletingProviderId(null)}
            />
          )}
        </div>
      </div>
    </PageLayout>
  );
}

function DeleteSsoProviderDialog({
  providerId,
  open,
  onOpenChange,
}: {
  providerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteSsoProvider = useDeleteSsoProvider();

  const handleDelete = useCallback(async () => {
    await deleteSsoProvider.mutateAsync(providerId);
    onOpenChange(false);
  }, [providerId, deleteSsoProvider, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete SSO Provider</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this SSO provider? This action
            cannot be undone and will prevent users from signing in through this
            provider.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteSsoProvider.isPending}
          >
            {deleteSsoProvider.isPending ? "Deleting..." : "Delete Provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SsoProvidersSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <SsoProvidersSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
