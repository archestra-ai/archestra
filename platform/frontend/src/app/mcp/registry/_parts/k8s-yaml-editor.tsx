"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Editor } from "@/components/editor";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  useResetDeploymentYaml,
  useValidateDeploymentYaml,
} from "@/lib/mcp/internal-mcp-catalog.query";

interface K8sYamlEditorProps {
  /** The catalog item ID to fetch the default YAML template for reset */
  catalogId?: string;
  /** Current YAML value from the form (comes from API response) */
  value: string | undefined;
  /** Callback when YAML changes */
  onChange: (value: string) => void;
  /** Whether the catalog item has been saved */
  isSaved?: boolean;
}

/**
 * YAML editor for Kubernetes Deployment spec customization.
 * Shows a Monaco editor with YAML syntax highlighting and real-time validation.
 * The YAML value comes directly from the API response (generated if not saved).
 */
export function K8sYamlEditor({
  catalogId,
  value,
  onChange,
  isSaved = false,
}: K8sYamlEditorProps) {
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  // Mutation to reset deployment YAML to default
  const resetYaml = useResetDeploymentYaml();

  // Validation mutation
  const validateYaml = useValidateDeploymentYaml();

  // Validate YAML on change (debounced)
  // biome-ignore lint/correctness/useExhaustiveDependencies: validateYaml.mutate is stable from useMutation
  useEffect(() => {
    if (!value) {
      setValidationErrors([]);
      setValidationWarnings([]);
      return;
    }

    const timeoutId = setTimeout(() => {
      validateYaml.mutate(
        { yaml: value },
        {
          onSuccess: (result) => {
            setValidationErrors(result?.errors ?? []);
            setValidationWarnings(result?.warnings ?? []);
          },
        },
      );
    }, 500); // Debounce validation by 500ms

    return () => clearTimeout(timeoutId);
  }, [value]);

  const handleEditorChange = useCallback(
    (newValue: string | undefined) => {
      onChange(newValue ?? "");
    },
    [onChange],
  );

  const handleResetToDefault = useCallback(() => {
    if (!catalogId) return;
    resetYaml.mutate(catalogId, {
      onSuccess: (data) => {
        if (data?.yaml) {
          onChange(data.yaml);
        }
      },
    });
  }, [catalogId, resetYaml, onChange]);

  // Show placeholder when not saved yet
  if (!isSaved) {
    return (
      <div className="space-y-3">
        <div className="border rounded-md p-4 bg-muted/50">
          <p className="text-sm text-muted-foreground">
            Save the MCP server first to enable the YAML editor. The editor will
            generate a template based on your environment variables
            configuration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Validation Errors */}
      {validationErrors.length > 0 && (
        <InlineNotice variant="error">
          <AlertCircle />
          <InlineNoticeText>
            <ul className="list-disc list-inside space-y-1">
              {validationErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </InlineNoticeText>
        </InlineNotice>
      )}

      {/* Validation Warnings */}
      {validationWarnings.length > 0 && (
        <InlineNotice variant="warning">
          <AlertCircle />
          <InlineNoticeText>
            <ul className="list-disc list-inside space-y-1">
              {validationWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </InlineNoticeText>
        </InlineNotice>
      )}

      {/* Editor Header with Reset Button */}
      <div className="flex justify-end items-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleResetToDefault}
          disabled={!catalogId || resetYaml.isPending}
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Reset to Default
        </Button>
      </div>

      {/* Monaco Editor */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        <Editor
          height="100%"
          defaultLanguage="yaml"
          value={value || ""}
          onChange={handleEditorChange}
          loading={
            <div className="flex h-full items-center justify-center w-full bg-muted/50">
              <p className="text-sm text-muted-foreground">Loading editor...</p>
            </div>
          }
          options={{
            minimap: { enabled: false },
            lineNumbers: "on",
            folding: true,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            fontSize: 13,
            fontFamily: "monospace",
            tabSize: 2,
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: "line",
            scrollbar: {
              vertical: "auto",
              horizontal: "auto",
              verticalScrollbarSize: 10,
            },
          }}
        />
      </div>
    </div>
  );
}
