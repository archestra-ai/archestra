"use client";

import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SingleSelectCombobox } from "@/components/ui/single-select-combobox";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import { useIndexKnowledgeFiles } from "@/lib/knowledge/knowledge-file.query";

/**
 * Adds a selection of documents to ONE knowledge base, or creates one from
 * them.
 *
 * One base per operation on purpose: a document belongs to exactly one
 * connector, so a document in two bases means two rows and two embedding
 * passes. Not worth paying before anyone asks.
 */
export function AddToKnowledgeBaseDialog({
  open,
  onOpenChange,
  fileIds,
  directoryIds,
  documentCount,
  onIndexed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileIds: string[];
  directoryIds: string[];
  documentCount: number;
  onIndexed: () => void;
}) {
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const newNameRef = useRef<HTMLInputElement>(null);

  const { data: knowledgeBases } = useKnowledgeBases();
  const indexFiles = useIndexKnowledgeFiles();

  useEffect(() => {
    if (!open) return;
    setKnowledgeBaseId("");
    setNewName("");
    setCreating(false);
  }, [open]);

  // Focus follows the user's own click on "Create a new knowledge base", which
  // swaps the combobox for this field in the same slot — without it the click
  // appears to do nothing and focus is left behind on a button that is gone.
  useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

  const canSubmit = creating
    ? newName.trim().length > 0
    : Boolean(knowledgeBaseId);

  const handleSubmit = () => {
    indexFiles.mutate(
      {
        fileIds,
        directoryIds,
        ...(creating
          ? { newKnowledgeBaseName: newName.trim() }
          : { knowledgeBaseId }),
      },
      {
        onSuccess: () => {
          onIndexed();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add to knowledge base"
      description={`${documentCount} ${documentCount === 1 ? "document" : "documents"} will be indexed. Agents assigned to the knowledge base can then retrieve them.`}
      size="small"
    >
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
        <Label htmlFor="target-knowledge-base">Knowledge base</Label>

        {/* A combobox with a "create" affordance underneath, rather than a
            two-tab switch: picking an existing base is the common case, and
            tabs made a one-field form look like two modes. */}
        {creating ? (
          <div className="space-y-1.5">
            <input
              id="target-knowledge-base"
              ref={newNameRef}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Vendor due diligence"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-xs">
                Assign it to an agent afterwards to make it retrievable.
              </p>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setCreating(false)}
              >
                <span>Use an existing one</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <SingleSelectCombobox
              options={(knowledgeBases ?? []).map((knowledgeBase) => ({
                value: knowledgeBase.id,
                label: knowledgeBase.name,
              }))}
              value={knowledgeBaseId}
              onChange={setKnowledgeBaseId}
              placeholder="Select a knowledge base"
              searchPlaceholder="Search knowledge bases"
              emptyMessage="No knowledge bases yet"
              className="w-full"
            />
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setCreating(true)}
            >
              <Plus className="mr-1 h-3 w-3" />
              <span>Create a new knowledge base</span>
            </Button>
          </div>
        )}
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button
          disabled={!canSubmit || indexFiles.isPending}
          onClick={handleSubmit}
        >
          <span>{indexFiles.isPending ? "Adding…" : "Add"}</span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
