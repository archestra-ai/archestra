"use client";

import type { Monaco, OnMount } from "@monaco-editor/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
import {
  type PolicyDeclarations,
  useBatteryPolicySource,
  usePolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { cn } from "@/lib/utils/tailwind";
import { batteryDisplayName } from "./battery-display-name";
import {
  annotationDecorations,
  focusPolicyLine,
  policyAnnotations,
} from "./policy-decorations";
import { POLICY_EDITOR_OPTIONS } from "./policy-editor-options";
import { type PolicyFile, policyIncludeLinks } from "./policy-files";

/**
 * The open file, read-only, in an editor that fills the box it is given. The
 * organization policy marks each include and unused alias in its gutter, and
 * its include paths open their file on Cmd/Ctrl+click.
 */
export function PolicySourcePane({
  file,
  files,
  focusLine,
  onOpenEntry,
  serverRules,
  className,
}: {
  /** Read the file as an MCP server's rules, with no Guardrails permission. */
  serverRules?: boolean;
  file: PolicyFile;
  /** Every file of the policy: the include paths that can be opened. */
  files: PolicyFile[];
  focusLine?: number;
  onOpenEntry: (entry: string) => void;
  className?: string;
}) {
  return file.kind === "root" ? (
    <RootSource
      path={file.path}
      files={files}
      focusLine={focusLine}
      onOpenEntry={onOpenEntry}
      className={className}
    />
  ) : (
    <IncludeSource
      // One query per entry: a new file starts from its own loading state.
      key={file.key}
      entry={file.entry ?? file.path}
      serverRules={serverRules}
      focusLine={focusLine}
      className={className}
    />
  );
}

/**
 * What the editor answers when someone types into a read-only file: where
 * the file is changed instead, as Markdown. Null leaves the editor's own words.
 */
export const PolicyReadOnlyMessage = createContext<string | null>(null);

/** A read-only policy document in an editor that fills its container. */
export function PolicyPaneEditor({
  path,
  content,
  ariaLabel,
  focusLine,
  declarations = null,
  includeLinks,
  className,
}: {
  /** Names the editor's model, so each file keeps its own scroll position. */
  path: string;
  content: string;
  ariaLabel: string;
  focusLine?: number;
  /** The root's declarations, to mark its lines; null marks none. */
  declarations?: PolicyDeclarations | null;
  includeLinks?: { files: PolicyFile[]; onOpenEntry: (entry: string) => void };
  className?: string;
}) {
  const readOnlyMessage = useContext(PolicyReadOnlyMessage);
  const [mounted, setMounted] = useState<{
    editor: Parameters<OnMount>[0];
    monaco: Monaco;
  } | null>(null);
  const editor = mounted?.editor ?? null;

  const decorations = useMemo(
    () =>
      declarations
        ? annotationDecorations(policyAnnotations(declarations))
        : [],
    [declarations],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new path is a new model, which holds none of the old one's decorations
  useEffect(() => {
    if (!editor) return;
    const collection = editor.createDecorationsCollection(decorations);
    return () => collection.clear();
  }, [editor, decorations, path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new path is a new model, where the line is yet to be revealed
  useEffect(() => {
    if (!editor) return;
    return focusPolicyLine(editor, focusLine);
  }, [editor, focusLine, path]);

  const links = useRef(includeLinks);
  links.current = includeLinks;
  useEffect(() => {
    if (!mounted) return;
    const { editor: codeEditor, monaco } = mounted;
    const provider = monaco.languages.registerLinkProvider(POLICY_LANGUAGE, {
      provideLinks(model: TextModel) {
        const target = links.current;
        if (!target || model !== codeEditor.getModel()) return { links: [] };
        const entries = new Set(
          target.files.flatMap((file) =>
            file.entry && !file.disabled ? [file.entry] : [],
          ),
        );
        return {
          links: policyIncludeLinks(model.getValue(), entries).map((link) => ({
            range: new monaco.Range(
              link.line,
              link.startColumn,
              link.line,
              link.endColumn,
            ),
            url: monaco.Uri.from({
              scheme: INCLUDE_LINK_SCHEME,
              path: `/${link.entry}`,
            }),
            tooltip: "Open file",
          })),
        };
      },
    });
    const opener = monaco.editor.registerLinkOpener({
      open(resource: { scheme: string; path: string }) {
        if (resource.scheme !== INCLUDE_LINK_SCHEME) return false;
        links.current?.onOpenEntry(resource.path.replace(/^\//, ""));
        return true;
      },
    });
    return () => {
      provider.dispose();
      opener.dispose();
    };
  }, [mounted]);

  return (
    // Monaco measures its parent, so the editor sits in a box of its own
    // that takes the pane's size without growing it.
    <div className={cn("relative min-h-60", className)}>
      <div className="absolute inset-0">
        <Editor
          height="100%"
          language={POLICY_LANGUAGE}
          path={path}
          value={content}
          onMount={(nextEditor, monaco) =>
            setMounted({ editor: nextEditor, monaco })
          }
          options={{
            ...POLICY_EDITOR_OPTIONS,
            // These files run to thousands of lines.
            minimap: { enabled: true },
            fontSize: 13,
            padding: { top: 8, bottom: 8 },
            readOnly: true,
            readOnlyMessage: readOnlyMessage
              ? { value: readOnlyMessage }
              : undefined,
            ariaLabel,
            glyphMargin: declarations !== null,
          }}
        />
      </div>
    </div>
  );
}

export function PolicyPaneSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("p-3", className)}>
      <Skeleton className="h-full min-h-40 w-full" />
    </div>
  );
}

function RootSource({
  path,
  files,
  focusLine,
  onOpenEntry,
  className,
}: {
  path: string;
  files: PolicyFile[];
  focusLine?: number;
  onOpenEntry: (entry: string) => void;
  className?: string;
}) {
  const policy = useGuardrailsPolicy();
  const declarations = usePolicyDeclarations();
  if (policy.isLoading) return <PolicyPaneSkeleton className={className} />;
  if (policy.isError || !policy.data)
    return (
      <div className={cn("p-3", className)}>
        <QueryLoadError
          title="Could not load policy"
          error={policy.error}
          onRetry={() => policy.refetch()}
        />
      </div>
    );
  return (
    <PolicyPaneEditor
      path={path}
      content={policy.data.content}
      ariaLabel="Organization guardrails policy"
      focusLine={focusLine}
      // The annotations are line numbers into the revision they were read at.
      declarations={
        declarations.data?.rootRevision === policy.data.revision
          ? declarations.data
          : null
      }
      includeLinks={{ files, onOpenEntry }}
      className={className}
    />
  );
}

/** One include: the exact battery a tool rule links to, or a repository file. */
function IncludeSource({
  entry,
  serverRules,
  focusLine,
  className,
}: {
  entry: string;
  serverRules?: boolean;
  focusLine?: number;
  className?: string;
}) {
  const source = useBatteryPolicySource(entry, { serverRules });
  if (source.isPending) return <PolicyPaneSkeleton className={className} />;
  if (source.isError || !source.data)
    return (
      <div className={cn("p-3", className)}>
        <QueryLoadError
          title="Could not load battery policy source"
          error={source.error}
          onRetry={() => source.refetch()}
        />
      </div>
    );
  const file = source.data.kind === "repository";
  const name = file ? source.data.name : batteryDisplayName(source.data.name);
  return (
    <PolicyPaneEditor
      path={entry}
      content={source.data.content}
      ariaLabel={file ? `${name} TOML` : `${name} battery policy TOML`}
      focusLine={focusLine}
      className={className}
    />
  );
}

type TextModel = NonNullable<ReturnType<Parameters<OnMount>[0]["getModel"]>>;

const POLICY_LANGUAGE = "ini";
const INCLUDE_LINK_SCHEME = "policy-file";
