"use client";

import {
  getIdentityProviderDialogNavButtonTestId,
  type IdentityProviderFormValues,
} from "@shared";
import { IdCard, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { cn } from "@/lib/utils";

export type IdentityProviderDialogSection =
  | "general"
  | "service-provider-metadata"
  | "attribute-mapping"
  | "enterprise-managed-credentials"
  | "role-mapping"
  | "team-sync";

export interface IdentityProviderDialogNavItem {
  id: IdentityProviderDialogSection;
  label: string;
}

interface IdentityProviderDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  providerLabel: string;
  form: UseFormReturn<IdentityProviderFormValues>;
  activeSection: IdentityProviderDialogSection;
  navItems: IdentityProviderDialogNavItem[];
  onActiveSectionChange: (section: IdentityProviderDialogSection) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer: ReactNode;
  sidebarFooter?: ReactNode;
}

export function IdentityProviderDialogShell({
  open,
  onOpenChange,
  title,
  description,
  providerLabel,
  form,
  activeSection,
  navItems,
  onActiveSectionChange,
  onSubmit,
  children,
  footer,
  sidebarFooter,
}: IdentityProviderDialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-6xl h-[85vh] flex flex-row p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Form {...form}>
          <DialogForm className="contents" onSubmit={onSubmit}>
            <nav className="w-[240px] border-r flex flex-col shrink-0">
              <div className="flex min-h-[72px] items-center border-b px-4 py-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted">
                    <IdCard className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-sm truncate">
                      {providerLabel}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Identity Provider
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-0.5 px-2 py-3 flex-1">
                {navItems.map((navItem) => (
                  <Button
                    key={navItem.id}
                    type="button"
                    variant="ghost"
                    data-testid={getIdentityProviderDialogNavButtonTestId(
                      navItem.id,
                    )}
                    className={cn(
                      "justify-start h-9 px-3 font-normal w-full",
                      activeSection === navItem.id &&
                        "bg-accent text-accent-foreground font-medium",
                    )}
                    onClick={() => onActiveSectionChange(navItem.id)}
                  >
                    {navItem.label}
                  </Button>
                ))}
              </div>

              {sidebarFooter && (
                <div className="px-2 pb-3 flex flex-col gap-1.5">
                  {sidebarFooter}
                </div>
              )}
            </nav>

            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <div className="flex min-h-[72px] shrink-0 items-center justify-between border-b px-4 py-4">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold truncate">{title}</h2>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-xs opacity-70 hover:opacity-100"
                  onClick={() => onOpenChange(false)}
                >
                  <XIcon className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </Button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-6">
                  {children}
                </div>
              </div>
              <DialogStickyFooter className="mt-0">{footer}</DialogStickyFooter>
            </div>
          </DialogForm>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
