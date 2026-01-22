"use client";

import { Plus, Tags, X } from "lucide-react";
import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ProfileLabel {
  key: string;
  value: string;
  keyId?: string;
  valueId?: string;
}

interface ProfileLabelsProps {
  labels: ProfileLabel[];
  onLabelsChange: (labels: ProfileLabel[]) => void;
}

export interface ProfileLabelsRef {
  saveUnsavedLabel: () => ProfileLabel[] | null;
}

export const ProfileLabels = forwardRef<ProfileLabelsRef, ProfileLabelsProps>(
  function ProfileLabels({ labels, onLabelsChange }, ref) {
    const [newLabelKey, setNewLabelKey] = useState("");
    const [newLabelValue, setNewLabelValue] = useState("");

    // Check if the current key already exists
    const isDuplicateKey =
      newLabelKey.trim() !== "" &&
      labels.some((l) => l.key === newLabelKey.trim());

    const handleAddLabel = useCallback(() => {
      const key = newLabelKey.trim();
      const value = newLabelValue.trim();

      if (!key || !value) {
        return;
      }

      // Check if key already exists
      const existingLabelIndex = labels.findIndex((label) => label.key === key);

      if (existingLabelIndex >= 0) {
        // Update existing label
        const updatedLabels = [...labels];
        updatedLabels[existingLabelIndex] = { key, value };
        onLabelsChange(updatedLabels);
      } else {
        // Add new label
        onLabelsChange([...labels, { key, value }]);
      }

      setNewLabelKey("");
      setNewLabelValue("");
    }, [newLabelKey, newLabelValue, labels, onLabelsChange]);

    const handleRemoveLabel = useCallback(
      (key: string) => {
        onLabelsChange(labels.filter((label) => label.key !== key));
      },
      [labels, onLabelsChange],
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleAddLabel();
        }
      },
      [handleAddLabel],
    );

    // Expose method to save unsaved label
    useImperativeHandle(ref, () => ({
      saveUnsavedLabel: () => {
        const key = newLabelKey.trim();
        const value = newLabelValue.trim();

        if (!key || !value) {
          return null;
        }

        // Check if key already exists
        const existingLabelIndex = labels.findIndex(
          (label) => label.key === key,
        );

        let updatedLabels: ProfileLabel[];
        if (existingLabelIndex >= 0) {
          // Update existing label
          updatedLabels = [...labels];
          updatedLabels[existingLabelIndex] = { key, value };
        } else {
          // Add new label
          updatedLabels = [...labels, { key, value }];
        }

        onLabelsChange(updatedLabels);
        setNewLabelKey("");
        setNewLabelValue("");
        return updatedLabels;
      },
    }));

    return (
      <div className="grid gap-4">
        <Label>Labels</Label>

        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Input
              id="label-key"
              value={newLabelKey}
              onChange={(e) => setNewLabelKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., environment"
              className="w-full"
              aria-label="Label key"
            />
          </div>

          <div className="flex-1">
            <Input
              id="label-value"
              value={newLabelValue}
              onChange={(e) => setNewLabelValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., production"
              className="w-full"
              aria-label="Label value"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleAddLabel}
            disabled={!newLabelKey.trim() || !newLabelValue.trim()}
            className="shrink-0"
            aria-label="Add label"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {isDuplicateKey && (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            This will update the existing &ldquo;{newLabelKey.trim()}&rdquo;
            label
          </p>
        )}

        {labels.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {labels.map((label) => (
              <Badge
                key={label.key}
                variant="secondary"
                className="flex items-center gap-1 pr-1"
              >
                <span className="font-semibold">{label.key}:</span>
                <span>{label.value}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveLabel(label.key)}
                  className="ml-1 hover:bg-destructive/20 rounded-full p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-6 text-center border border-dashed rounded-lg bg-muted/30">
            <Tags className="h-8 w-8 mb-2 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No labels added yet</p>
            <p className="text-xs text-muted-foreground/70">
              Labels help organize and filter your profiles
            </p>
          </div>
        )}
      </div>
    );
  },
);
