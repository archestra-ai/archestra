"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
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
  /** Show the YAML without letting the user change or reset it */
  readOnly?: boolean;
  help?: ReactNode;
  onValidationChange?: (valid: boolean) => void;
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
  readOnly = false,
  help,
  onValidationChange,
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
    onValidationChange?.(false);
    if (!value) {
      setValidationErrors([]);
      setValidationWarnings([]);
      return;
    }

    let active = true;
    const timeoutId = setTimeout(() => {
      validateYaml.mutate(
        { yaml: value, catalogId },
        {
          onSuccess: (result) => {
            if (!active) return;
            setValidationErrors(
              result?.errors ?? ["Unable to validate YAML. Try again."],
            );
            onValidationChange?.(result?.valid === true);
            setValidationWarnings(result?.warnings ?? []);
          },
        },
      );
    }, 500); // Debounce validation by 500ms

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [value, catalogId, onValidationChange]);

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
      {(validationErrors.length > 0 || validationWarnings.length > 0) && (
        <div className="shrink-0 space-y-2">
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
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Deployment YAML</span>
              {readOnly && (
                <span className="text-xs text-muted-foreground">Read only</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Customize the Kubernetes deployment to mount secrets or volumes,
              adjust resources, or add labels and annotations.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {help}
            {!readOnly && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Reset to default"
                onClick={handleResetToDefault}
                disabled={!catalogId || resetYaml.isPending}
              >
                <RefreshCw className="size-3.5" />
                <span>Reset</span>
              </Button>
            )}
          </div>
        </div>

        {/* Monaco Editor */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Editor
            height="100%"
            defaultLanguage="yaml"
            value={value || ""}
            onChange={handleEditorChange}
            loading={
              <div className="flex h-full items-center justify-center w-full bg-muted/50">
                <p className="text-sm text-muted-foreground">
                  Loading editor...
                </p>
              </div>
            }
            options={{
              readOnly,
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
    </div>
  );
}
