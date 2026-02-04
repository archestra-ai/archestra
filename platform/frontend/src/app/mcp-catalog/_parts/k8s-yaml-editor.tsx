"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Editor } from "@/components/editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  useResetDeploymentYaml,
  useValidateDeploymentYaml,
} from "@/lib/internal-mcp-catalog.query";

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
    <div className="space-y-3">
      {/* Validation Errors */}
      {validationErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <ul className="list-disc list-inside space-y-1">
              {validationErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Validation Warnings */}
      {validationWarnings.length > 0 && (
        <Alert
          variant="default"
          className="border-yellow-500/50 bg-yellow-50 dark:bg-yellow-950/20"
        >
          <AlertCircle className="h-4 w-4 text-yellow-600" />
          <AlertDescription className="text-yellow-800 dark:text-yellow-200">
            <ul className="list-disc list-inside space-y-1">
              {validationWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
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
      <div className="border rounded-md overflow-hidden">
        <Editor
          height="400px"
          defaultLanguage="yaml"
          value={value || ""}
          onChange={handleEditorChange}
          loading={
            <div className="flex items-center justify-center h-[400px] bg-muted/50">
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
