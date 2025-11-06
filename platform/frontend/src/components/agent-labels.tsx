"use client";

import { Plus, X } from "lucide-react";
import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLabelValues } from "@/lib/agent.query";

export interface AgentLabel {
  key: string;
  value: string;
  keyId?: string;
  valueId?: string;
}

interface AgentLabelsProps {
  labels: AgentLabel[];
  onLabelsChange: (labels: AgentLabel[]) => void;
  availableKeys?: string[];
}

export interface AgentLabelsRef {
  saveUnsavedLabel: () => AgentLabel[] | null;
}

export const AgentLabels = forwardRef<AgentLabelsRef, AgentLabelsProps>(
  function AgentLabels({ labels, onLabelsChange, availableKeys = [] }, ref) {
    const [newLabelKey, setNewLabelKey] = useState("");
    const [newLabelValue, setNewLabelValue] = useState("");

    // Fetch values for the current key (only if key is not empty)
    const { data: valuesForKey = [] } = useLabelValues({
      key: newLabelKey.trim() || undefined,
    });

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

        let updatedLabels: AgentLabel[];
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
        <div>
          <Label>Labels</Label>
          <p className="text-sm text-muted-foreground mb-2">
            Add labels to organize and identify your agents
          </p>
        </div>

        <div className="flex gap-2 items-end">
          <div className="flex-1 grid gap-1.5">
            <Label htmlFor="label-key" className="text-xs">
              Key
            </Label>
            <Input
              id="label-key"
              list="label-keys-list"
              value={newLabelKey}
              onChange={(e) => setNewLabelKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., environment"
              className="w-full"
            />
            <datalist id="label-keys-list">
              {availableKeys.map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          </div>

          <div className="flex-1 grid gap-1.5">
            <Label htmlFor="label-value" className="text-xs">
              Value
            </Label>
            <Input
              id="label-value"
              list="label-values-list"
              value={newLabelValue}
              onChange={(e) => setNewLabelValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., production"
              className="w-full"
            />
            <datalist id="label-values-list">
              {valuesForKey.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </div>

          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleAddLabel}
            disabled={!newLabelKey.trim() || !newLabelValue.trim()}
            className="shrink-0"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

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
          <p className="text-sm text-muted-foreground">No labels added yet</p>
        )}
      </div>
    );
  },
);
