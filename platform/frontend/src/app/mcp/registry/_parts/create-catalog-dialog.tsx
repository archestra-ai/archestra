"use client";

import type { archestraApiTypes } from "@shared";
import { ArrowLeft, Search } from "lucide-react";
import { useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import {
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
}

type WizardStep = "form" | "catalog-browse";

export function CreateCatalogDialog({
  isOpen,
  onClose,
  onSuccess,
}: CreateCatalogDialogProps) {
  const [step, setStep] = useState<WizardStep>("form");
  const [prefilledValues, setPrefilledValues] = useState<
    McpCatalogFormValues | undefined
  >(undefined);
  const createMutation = useCreateInternalMcpCatalogItem();
  const { data: catalogItems } = useInternalMcpCatalog();

  const handleClose = () => {
    setStep("form");
    setPrefilledValues(undefined);
    onClose();
  };

  const onSubmit = async (values: McpCatalogFormValues) => {
    const apiData = transformFormToApiData(values);
    const createdItem = await createMutation.mutateAsync(apiData);
    handleClose();
    if (createdItem) {
      onSuccess?.(createdItem);
    }
  };

  const handleSelectFromCatalog = (formValues: McpCatalogFormValues) => {
    setPrefilledValues(formValues);
    setStep("form");
  };

  const footer = (
    <DialogStickyFooter className="mt-0">
      <Button variant="outline" onClick={handleClose} type="button">
        Cancel
      </Button>
      <Button type="submit" disabled={createMutation.isPending}>
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
