"use client";

import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/loading";
import {
  ssoProviderKeys,
  useCreateSsoProvider,
  useDeleteSsoProvider,
  useSsoProviders,
  useUpdateSsoProvider,
} from "@/lib/sso-provider.query";
import { SsoProviderForm } from "@/components/sso-provider-form";
import { SsoProviderList } from "@/components/sso-provider-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

function SsoProvidersSettingsContent() {
  const { data: providers } = useSsoProviders();
  const createMutation = useCreateSsoProvider();
  const updateMutation = useUpdateSsoProvider();
  const deleteMutation = useDeleteSsoProvider();
  const queryClient = useQueryClient();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  const handleCreate = async (data: any) => {
    await createMutation.mutateAsync(data);
    setCreateDialogOpen(false);
  };

  const handleUpdate = async (data: any) => {
    if (!selectedProvider) return;
    await updateMutation.mutateAsync({ id: selectedProvider, data });
    setEditDialogOpen(false);
    setSelectedProvider(null);
  };

  const handleDelete = async () => {
    if (!selectedProvider) return;
    await deleteMutation.mutateAsync(selectedProvider);
    setDeleteDialogOpen(false);
    setSelectedProvider(null);
  };

  const providerToEdit = selectedProvider
    ? providers.find((p) => p.id === selectedProvider)
    : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SSO Providers</h1>
          <p className="text-muted-foreground mt-1">
            Configure OIDC and SAML providers for single sign-on authentication
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Provider
        </Button>
      </div>

      <SsoProviderList
        providers={providers}
        onEdit={(id) => {
          setSelectedProvider(id);
          setEditDialogOpen(true);
        }}
        onDelete={(id) => {
          setSelectedProvider(id);
          setDeleteDialogOpen(true);
        }}
      />

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create SSO Provider</DialogTitle>
            <DialogDescription>
              Configure a new OIDC or SAML provider for your organization
            </DialogDescription>
          </DialogHeader>
          <SsoProviderForm
            onSubmit={handleCreate}
            onCancel={() => setCreateDialogOpen(false)}
            isLoading={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit SSO Provider</DialogTitle>
            <DialogDescription>
              Update the configuration for this SSO provider
            </DialogDescription>
          </DialogHeader>
          {providerToEdit && (
            <SsoProviderForm
              initialData={providerToEdit}
              onSubmit={handleUpdate}
              onCancel={() => {
                setEditDialogOpen(false);
                setSelectedProvider(null);
              }}
              isLoading={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete SSO Provider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this SSO provider? This action
              cannot be undone. Users will no longer be able to sign in using
              this provider.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setDeleteDialogOpen(false);
                setSelectedProvider(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
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
