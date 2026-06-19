"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ArrowLeft, Copy, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import {
  getCatalogMutationErrorCode,
  REMOTE_SERVER_URL_NOT_ALLOWED_CODE,
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { ArchestraCatalogTab } from "./archestra-catalog-tab";
import { McpCatalogForm } from "./mcp-catalog-form";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformFormToApiData } from "./mcp-catalog-form.utils";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface CreateCatalogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (createdItem: CatalogItem) => void;
  /** When set, seeds the form for a "clone" of an existing catalog item. */
  cloneValues?: McpCatalogFormValues;
  /** Source catalog item id when cloning; persisted as the new item's `clonedFrom`. */
  clonedFrom?: string;
}

type WizardStep = "form" | "catalog-browse";

export function CreateCatalogDialog({
  isOpen,
  onClose,
  onSuccess,
  cloneValues,
  clonedFrom,
}: CreateCatalogDialogProps) {
  const [step, setStep] = useState<WizardStep>("form");
  const [prefilledValues, setPrefilledValues] = useState<
    McpCatalogFormValues | undefined
  >(undefined);
  const createMutation = useCreateInternalMcpCatalogItem();
  const { data: catalogItems } = useInternalMcpCatalog();

  // Seed the form when opened for a clone. cloneValues is a new object per
  // clone action; the parent clears it on close so reopening via "Add Server"
  // starts blank.
  useEffect(() => {
    if (isOpen && cloneValues) {
      setPrefilledValues(cloneValues);
      setStep("form");
    }
  }, [isOpen, cloneValues]);

  const handleClose = () => {
    setStep("form");
    setPrefilledValues(undefined);
    onClose();
  };

  const onSubmit = (
    values: McpCatalogFormValues,
    form: UseFormReturn<McpCatalogFormValues>,
  ) => {
    const apiData = {
      ...transformFormToApiData(values),
      // Record clone lineage (null for a plain "Add Server").
      clonedFrom: clonedFrom ?? null,
    };
    // Use the callback form so the dialog only closes on success; on a
    // validation error the dialog stays open for correction.
    createMutation.mutate(apiData, {
      onSuccess: (createdItem) => {
        handleClose();
        if (createdItem) {
          onSuccess?.({ ...createdItem, toolCount: 0 });
        }
      },
      onError: (error) => {
        // Network-policy rejections point at the Server URL — show them inline
        // on that field rather than as a toast.
        if (
          getCatalogMutationErrorCode(error) ===
          REMOTE_SERVER_URL_NOT_ALLOWED_CODE
        ) {
          form.setError("serverUrl", {
            type: "server",
            message:
              error instanceof Error
                ? error.message
                : "Server URL is not allowed by the environment's network policy.",
          });
        }
      },
    });
  };

  const handleSelectFromCatalog = (formValues: McpCatalogFormValues) => {
    setPrefilledValues(formValues);
    setStep("form");
  };

  const footer = ({ hasBlockingErrors }: { hasBlockingErrors: boolean }) => (
    <DialogStickyFooter className="mt-0">
      <Button variant="outline" onClick={handleClose} type="button">
        Cancel
      </Button>
      <Button
        type="submit"
        disabled={createMutation.isPending || hasBlockingErrors}
      >
        {createMutation.isPending ? "Adding..." : "Add Server"}
      </Button>
    </DialogStickyFooter>
  );

  const catalogButton = (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={() => setStep("catalog-browse")}
    >
      <Search className="h-4 w-4" />
      Select from Online Catalog
    </Button>
  );

  return (
    <FormDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      title={
        step === "catalog-browse" ? (
          <button
            type="button"
            onClick={() => setStep("form")}
            className="inline-flex items-center gap-2 text-left"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Add MCP Server to the Private Registry</span>
          </button>
        ) : (
          "Add MCP Server to the Private Registry"
        )
      }
      description={
        step === "form"
          ? "Once you add an MCP server here, it will be available for installation."
          : "Select a server from the online catalog to pre-fill the form."
      }
      size="large"
    >
      {step === "form" && (
        <McpCatalogForm
          mode="create"
          onSubmit={onSubmit}
          footer={footer}
          catalogButton={catalogButton}
          notice={
            cloneValues ? (
              <Alert>
                <Copy className="h-4 w-4" />
                <AlertDescription>
                  Cloning an existing server — its configuration (including
                  secrets) is pre-filled here. Adjust anything you like, then
                  save to create a new registry entry.
                </AlertDescription>
              </Alert>
            ) : undefined
          }
          formValues={prefilledValues}
        />
      )}

      {step === "catalog-browse" && (
        <DialogBody className="pt-3">
          <ArchestraCatalogTab
            catalogItems={catalogItems}
            onSelectServer={handleSelectFromCatalog}
          />
        </DialogBody>
      )}
    </FormDialog>
  );
}
