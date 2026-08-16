// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type ColumnInput = {
  id: string;
  title: string;
  prompt: string;
  outputFormat: "text" | "yes_no" | "date" | "number" | "list" | "json";
};

export function CreateDocReviewModal({
  isOpen,
  onClose,
  knowledgeBases,
  onSubmit,
}: {
  isOpen: boolean;
  onClose: () => void;
  knowledgeBases: { id: string; name: string }[];
  onSubmit: (params: {
    name: string;
    description?: string;
    knowledgeBaseId?: string;
    columns: ColumnInput[];
    documentIds: string[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [documents, setDocuments] = useState<{ id: string; title: string }[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [columns, setColumns] = useState<ColumnInput[]>([
    {
      id: "col-1",
      title: "Key Takeaway",
      prompt: "What is the primary conclusion or root cause?",
      outputFormat: "text",
    },
  ]);
  const [submitting, setSubmitting] = useState(false);

  const handleKbChange = async (kbId: string) => {
    setSelectedKbId(kbId);
    setLoadingDocs(true);
    try {
      const res = await fetch(`/api/knowledge-bases/${kbId}/documents`);
      if (res.ok) {
        const data = await res.json();
        const docs = data.documents ?? [];
        setDocuments(docs);
        setSelectedDocIds(docs.map((d: any) => d.id)); // Default select all
      }
    } catch {
      setDocuments([]);
    } finally {
      setLoadingDocs(false);
    }
  };

  const addColumn = () => {
    const nextId = `col-${columns.length + 1}`;
    setColumns([
      ...columns,
      {
        id: nextId,
        title: "",
        prompt: "",
        outputFormat: "text",
      },
    ]);
  };

  const removeColumn = (id: string) => {
    setColumns(columns.filter((c) => c.id !== id));
  };

  const updateColumn = (id: string, updates: Partial<ColumnInput>) => {
    setColumns(
      columns.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || columns.length === 0 || selectedDocIds.length === 0) return;

    setSubmitting(true);
    try {
      await onSubmit({
        name,
        description: description || undefined,
        knowledgeBaseId: selectedKbId || undefined,
        columns,
        documentIds: selectedDocIds,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Bulk Document Review</DialogTitle>
            <DialogDescription>
              Define a question schema across a set of documents to execute in bulk.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="review-name">Review Title</Label>
              <Input
                id="review-name"
                placeholder="e.g. Vendor Security Questionnaire Audit Q3"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="review-desc">Description (Optional)</Label>
              <Textarea
                id="review-desc"
                placeholder="Brief description of the review objective..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            {/* Knowledge Base Selection */}
            <div className="space-y-1.5">
              <Label>Source Knowledge Base</Label>
              <Select value={selectedKbId} onValueChange={handleKbChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select Knowledge Base..." />
                </SelectTrigger>
                <SelectContent>
                  {knowledgeBases.map((kb) => (
                    <SelectItem key={kb.id} value={kb.id}>
                      {kb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedKbId && (
              <div className="bg-muted p-3 rounded-md space-y-2 text-xs">
                <div className="flex justify-between items-center font-medium text-foreground">
                  <span>Target Documents ({selectedDocIds.length} of {documents.length} selected)</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px]"
                    onClick={() =>
                      setSelectedDocIds(
                        selectedDocIds.length === documents.length
                          ? []
                          : documents.map((d) => d.id),
                      )
                    }
                  >
                    {selectedDocIds.length === documents.length ? "Deselect All" : "Select All"}
                  </Button>
                </div>
                {loadingDocs ? (
                  <p className="text-muted-foreground italic">Loading KB documents...</p>
                ) : documents.length === 0 ? (
                  <p className="text-muted-foreground">No documents found in this Knowledge Base.</p>
                ) : (
                  <div className="max-h-32 overflow-y-auto space-y-1 pr-1">
                    {documents.map((doc) => (
                      <label key={doc.id} className="flex items-center gap-2 cursor-pointer hover:bg-background/50 p-1 rounded">
                        <input
                          type="checkbox"
                          checked={selectedDocIds.includes(doc.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedDocIds([...selectedDocIds, doc.id]);
                            } else {
                              setSelectedDocIds(selectedDocIds.filter((id) => id !== doc.id));
                            }
                          }}
                        />
                        <span className="truncate">{doc.title}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Column Schema Definition */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <Label className="font-semibold text-sm">Review Questions / Columns</Label>
                <Button type="button" variant="outline" size="sm" onClick={addColumn}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add Column
                </Button>
              </div>

              <div className="space-y-3">
                {columns.map((col, index) => (
                  <div key={col.id} className="border rounded-md p-3 space-y-2 bg-card relative">
                    <div className="flex items-center justify-between gap-2">
                      <Input
                        placeholder={`Column Title (e.g. Field ${index + 1})`}
                        value={col.title}
                        onChange={(e) => updateColumn(col.id, { title: e.target.value })}
                        className="h-8 text-sm font-medium"
                        required
                      />
                      <Select
                        value={col.outputFormat}
                        onValueChange={(val: any) => updateColumn(col.id, { outputFormat: val })}
                      >
                        <SelectTrigger className="w-[140px] h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">Text</SelectItem>
                          <SelectItem value="yes_no">Yes / No</SelectItem>
                          <SelectItem value="date">Date</SelectItem>
                          <SelectItem value="number">Number</SelectItem>
                          <SelectItem value="list">List</SelectItem>
                          <SelectItem value="json">JSON</SelectItem>
                        </SelectContent>
                      </Select>
                      {columns.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive"
                          onClick={() => removeColumn(col.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      placeholder="Prompt / Question instruction for model..."
                      value={col.prompt}
                      onChange={(e) => updateColumn(col.id, { prompt: e.target.value })}
                      className="text-xs"
                      rows={2}
                      required
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !name.trim() || selectedDocIds.length === 0}
            >
              {submitting ? "Launching Run..." : "Launch Review Run"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
