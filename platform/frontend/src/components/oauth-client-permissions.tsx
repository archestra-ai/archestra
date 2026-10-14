// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { Shield, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { ResourcePermissions } from "@/components/resource-permissions";
import { TabbedDialogFooterSlot } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogCancelButton,
  DialogDismissProvider,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";

type ClientKind = "mcp" | "llm";

/** One entry for the two independent OAuth client registration policies. */
export function OAuthClientPermissions() {
  const { data: canRead } = useHasPermissions({ accessPolicies: ["read"] });
  const { data: canUpdate } = useHasPermissions({ accessPolicies: ["update"] });
  const [opened, setOpened] = useState(false);
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const linked = params.get("permissions") === "all";
  const onOpenChange = (open: boolean) => {
    setOpened(open);
    if (!open && linked) {
      const next = new URLSearchParams(params.toString());
      next.delete("permissions");
      next.delete("permissionResource");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
        scroll: false,
      });
    }
  };
  if (!canRead && !canUpdate) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpened(true)}
      >
        <Shield className="size-4" />
        <span>Permissions</span>
      </Button>
      {(opened || linked) && (
        <OAuthClientPermissionsDialog
          initialKind={
            linked && params.get("permissionResource") === "llmOauthClient"
              ? "llm"
              : "mcp"
          }
          onOpenChange={onOpenChange}
        />
      )}
    </>
  );
}

function OAuthClientPermissionsDialog({
  initialKind,
  onOpenChange,
}: {
  initialKind: ClientKind;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<ClientKind>(initialKind);
  const [isDirty, setIsDirty] = useState(false);
  const [pendingKind, setPendingKind] = useState<ClientKind | null>(null);
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);
  const guard = useUnsavedChangesGuard({ isDirty, onOpenChange });
  const changeKind = (next: ClientKind) => {
    if (next === kind) return;
    if (isDirty) setPendingKind(next);
    else setKind(next);
  };
  return (
    <>
      <Dialog open onOpenChange={guard.handleOpenChange}>
        <DialogContent
          className="max-w-4xl max-h-[85vh] gap-0 p-0"
          showCloseButton={false}
        >
          <DialogDismissProvider requestClose={guard.requestClose}>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <PageLayout
                compactHeader
                fillContent
                title={
                  <DialogTitle asChild>
                    <span>OAuth client permissions</span>
                  </DialogTitle>
                }
                description={
                  <DialogDescription asChild>
                    <span>{`Manage access to all ${kind.toUpperCase()} OAuth clients, including future clients.`}</span>
                  </DialogDescription>
                }
                tabs={(["mcp", "llm"] as const).map((value) => ({
                  label: `${value.toUpperCase()} clients`,
                  href: `#${value}-client-permissions`,
                  selected: value === kind,
                  onClick: (event) => {
                    event.preventDefault();
                    changeKind(value);
                  },
                }))}
                actionButton={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close"
                    onClick={guard.requestClose}
                  >
                    <X aria-hidden="true" />
                  </Button>
                }
              >
                <TabbedDialogFooterSlot.Provider value={footerSlot}>
                  <ResourcePermissions
                    key={kind}
                    resource={
                      kind === "mcp" ? "mcpOauthClient" : "llmOauthClient"
                    }
                    scope="*"
                    embedded
                    standalone
                    title={null}
                    description={null}
                    onDirtyChange={setIsDirty}
                  />
                </TabbedDialogFooterSlot.Provider>
              </PageLayout>
            </div>
            <DialogStickyFooter className="group/footer mt-0 shrink-0">
              <div className="flex justify-end group-has-[[data-section-actions]]/footer:hidden">
                <DialogCancelButton>Done</DialogCancelButton>
              </div>
              <div ref={setFooterSlot} className="flex-1 empty:hidden" />
            </DialogStickyFooter>
          </DialogDismissProvider>
        </DialogContent>
      </Dialog>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
      <UnsavedChangesDialog
        open={pendingKind !== null}
        onKeepEditing={() => setPendingKind(null)}
        onDiscard={() => {
          if (pendingKind) {
            setKind(pendingKind);
            setIsDirty(false);
          }
          setPendingKind(null);
        }}
      />
    </>
  );
}
