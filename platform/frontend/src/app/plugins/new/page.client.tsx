"use client";

import { POPULAR_PLUGIN_MARKETPLACES } from "@archestra/shared";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  FileText,
  Github,
  Loader2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { FilterBar } from "@/components/filter-bar";
import { PageWizard } from "@/components/page-wizard";
import { SearchInput } from "@/components/search-input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import { Separator } from "@/components/ui/separator";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useCreatePlugin } from "@/lib/plugins/plugin.query";
import { ImportMarketplaceDialog } from "../_parts/import-marketplace-dialog";
import {
  blankPluginDraft,
  isPluginDraftComplete,
  isPluginDraftDirty,
  type PluginDraft,
} from "../_parts/plugin-draft";
import { PluginForm } from "../_parts/plugin-form";
import { PluginBackLink } from "../_parts/plugin-page-shell";

type CreateStep = "source" | "configure";
type PluginImportState = { repoUrl: string; autoDiscover: boolean };

const CONFIGURE_STEPS = [{ id: "configure", title: "Configure" }] as const;

const STEP_DESCRIPTIONS: Record<CreateStep, string> = {
  source: "Import from GitHub, or start blank.",
  // The whole plugin is on one page, so the sentence names the whole of it —
  // and the plugin's own page says the same thing over the same form.
  configure:
    "Add the files this plugin installs, and choose who can discover it.",
};

export default function NewPluginPage() {
  return (
    <div className="h-full w-full">
      <ErrorBoundary>
        <NewPluginGate />
      </ErrorBoundary>
    </div>
  );
}

function NewPluginGate() {
  const enabled = useFeature("plugins");

  if (enabled === undefined) {
    return null;
  }

  if (!enabled) {
    return (
      <PageWizard
        title="Plugins"
        description="Plugins are disabled for this deployment."
      >
        <div />
      </PageWizard>
    );
  }

  return <NewPluginWizard />;
}

function NewPluginWizard() {
  const router = useRouter();
  const { data: canCreate } = useHasPermissions({
    plugin: ["create", "admin"],
  });
  const { data: canReadPlugins, isPending: isReadPermissionPending } =
    useHasPermissions({ plugin: ["read", "admin"] });
  const searchParams = useSearchParams();
  const initialSource = searchParams.get("source");
  const [importState, setImportState] = useState<PluginImportState | null>(
    initialSource === "marketplace"
      ? { repoUrl: "", autoDiscover: false }
      : null,
  );
  const [search, setSearch] = useState("");

  const [step, setStep] = useState<CreateStep>(
    initialSource === "blank" ? "configure" : "source",
  );
  const [draft, setDraft] = useState<PluginDraft>(blankPluginDraft);
  const blankDraft = useMemo(() => blankPluginDraft(), []);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const patchDraft = (patch: Partial<PluginDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const isComplete = isPluginDraftComplete({ draft, isGithubPlugin: false });
  const isDirty = useMemo(
    () => isPluginDraftDirty(draft, blankDraft),
    [blankDraft, draft],
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGuardBypassed, setIsGuardBypassed] = useState(false);
  const submittingRef = useRef(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const routedCreatedRef = useRef<string | null>(null);

  const createPlugin = useCreatePlugin();
  const handleCreate = async () => {
    if (
      submittingRef.current ||
      canCreate !== true ||
      !isComplete ||
      createPlugin.isPending
    )
      return;
    submittingRef.current = true;
    setIsSubmitting(true);
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? draft.labels;
    // A handled failure resolves to null and a rejection is reported by the
    // mutation's own `onError`; both keep the page where it is with the draft
    // intact, so the author can retry without retyping.
    const created = await createPlugin
      .mutateAsync({
        displayName: draft.displayName.trim(),
        description: draft.description,
        clientType: draft.clientType,
        supportedPlatforms: draft.supportedPlatforms,
        scope: draft.scope,
        teamIds: draft.scope === "team" ? draft.teamIds : [],
        userIds: draft.scope === "personal" ? draft.userIds : [],
        files: draft.files,
        labels: finalLabels,
      })
      .catch(() => null);
    if (!created) {
      submittingRef.current = false;
      setIsSubmitting(false);
      return;
    }
    setIsGuardBypassed(true);
    setDraft(blankDraft);
    setCreated({ id: created.id, name: draft.displayName.trim() || "Plugin" });
  };

  const guardedDirty = isDirty && !isGuardBypassed;
  useBeforeUnloadWhileDirty(guardedDirty);
  const pendingHrefRef = useRef<string | null>(null);
  const pendingImportRef = useRef<PluginImportState | null>(null);
  const isReadPermissionKnown = !isReadPermissionPending;
  const showsUnreadableSuccess =
    !!created && isReadPermissionKnown && canReadPlugins !== true;
  useEffect(() => {
    if (
      !created ||
      !isReadPermissionKnown ||
      canReadPlugins !== true ||
      routedCreatedRef.current === created.id
    )
      return;
    routedCreatedRef.current = created.id;
    router.push(`/plugins/${created.id}`);
  }, [canReadPlugins, created, isReadPermissionKnown, router]);
  const guard = useUnsavedChangesGuard({
    isDirty: guardedDirty,
    onOpenChange: (open) => {
      if (open) return;
      const pendingImport = pendingImportRef.current;
      pendingImportRef.current = null;
      if (pendingImport) {
        setIsGuardBypassed(false);
        setDraft(blankDraft);
        setStep("source");
        setImportState(pendingImport);
        return;
      }
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) {
        setIsGuardBypassed(true);
        setDraft(blankDraft);
        router.push(href);
      }
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      if (submittingRef.current) return;
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );
  useGuardedInAppNavigation({
    isDirty: guardedDirty,
    onRequestNavigate: requestNavigate,
  });

  const requestImport = useCallback(
    (nextImport: PluginImportState) => {
      if (!isDirty) {
        setImportState(nextImport);
        return;
      }
      pendingImportRef.current = nextImport;
      guard.requestClose();
    },
    [guard, isDirty],
  );
  const openImport = () => requestImport({ repoUrl: "", autoDiscover: false });
  const importPopular = (repoUrl: string) =>
    requestImport({ repoUrl, autoDiscover: true });
  const goToPlugins = () => router.push("/plugins");

  const filteredMarketplaces = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return POPULAR_PLUGIN_MARKETPLACES;
    return POPULAR_PLUGIN_MARKETPLACES.filter(
      (item) =>
        item.repo.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }, [search]);

  const isSearching = search.trim().length > 0;

  return (
    <>
      <PageWizard
        title="Add a new plugin"
        description={STEP_DESCRIPTIONS[step]}
        backLink={
          isSubmitting ? undefined : (
            <PluginBackLink href="/plugins" label="Plugins" />
          )
        }
        steps={created || step !== "configure" ? undefined : CONFIGURE_STEPS}
        activeStep={step === "configure" ? "configure" : undefined}
      >
        <div className="space-y-6">
          {showsUnreadableSuccess ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleCheck />
                </EmptyMedia>
                <EmptyTitle>Plugin created</EmptyTitle>
                <EmptyDescription>
                  <span>
                    &quot;{created?.name ?? "Plugin"}&quot; was created. You do
                    not have permission to view it.
                  </span>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : created ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Loader2 className="animate-spin" />
                </EmptyMedia>
                <EmptyTitle>Plugin created</EmptyTitle>
                <EmptyDescription>
                  Opening &quot;{created?.name ?? "Plugin"}&quot;…
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : step === "source" ? (
            <div className="mx-auto max-w-3xl space-y-8">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <CatalogSourceCard
                  icon={<Github className="size-5" />}
                  title="Custom GitHub URL"
                  description="Paste a GitHub marketplace URL."
                  onClick={openImport}
                />
                <CatalogSourceCard
                  icon={<FileText className="size-5" />}
                  title="Blank template"
                  description="Write the plugin files here."
                  onClick={() => setStep("configure")}
                />
              </div>

              <Card className="gap-0 py-0">
                <CardHeader className="gap-3 border-b py-4">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-base">
                      Popular marketplaces
                    </CardTitle>
                    <Badge variant="secondary" className="tabular-nums">
                      {isSearching
                        ? `${filteredMarketplaces.length} / ${POPULAR_PLUGIN_MARKETPLACES.length}`
                        : POPULAR_PLUGIN_MARKETPLACES.length}
                    </Badge>
                  </div>
                  <FilterBar
                    onClearFilters={search ? () => setSearch("") : undefined}
                    search={
                      <SearchInput
                        value={search}
                        onSearchChange={setSearch}
                        syncQueryParams={false}
                        placeholder="Search marketplaces by name or use case..."
                        className="w-full flex-1"
                      />
                    }
                  />
                </CardHeader>
                <CardContent className="p-0">
                  {filteredMarketplaces.length === 0 ? (
                    <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                      No marketplaces match “{search}”.
                    </div>
                  ) : (
                    <ul>
                      {filteredMarketplaces.map((item, idx) => {
                        const owner = item.repo.split("/")[0];
                        return (
                          <li key={item.repo}>
                            {idx > 0 && <Separator />}
                            <button
                              type="button"
                              onClick={() => importPopular(item.repo)}
                              className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                            >
                              <Avatar className="size-8">
                                <AvatarImage
                                  src={`https://github.com/${owner}.png?size=64`}
                                  alt=""
                                />
                                <AvatarFallback>
                                  <Github className="size-4 text-muted-foreground" />
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-sm font-medium">
                                  {item.repo}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {item.description}
                                </div>
                              </div>
                              <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          {!created && step === "configure" && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreate();
              }}
            >
              <PluginForm
                draft={draft}
                onChange={patchDraft}
                labelsRef={labelsRef}
                readOnly={isSubmitting}
                isCreate
              />
              <WizardFooter>
                <Button
                  variant="outline"
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setStep("source")}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                <PermissionButton
                  permissions={{ plugin: ["create", "admin"] }}
                  type="submit"
                  disabled={
                    canCreate !== true ||
                    !isComplete ||
                    createPlugin.isPending ||
                    isSubmitting
                  }
                >
                  {createPlugin.isPending ? "Creating..." : "Create plugin"}
                </PermissionButton>
              </WizardFooter>
            </form>
          )}
        </div>
      </PageWizard>

      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          pendingImportRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />

      <ImportMarketplaceDialog
        open={importState !== null}
        initialRepoUrl={importState?.repoUrl ?? ""}
        autoDiscover={importState?.autoDiscover ?? false}
        onOpenChange={(open) => {
          if (!open) setImportState(null);
        }}
        onImported={goToPlugins}
      />
    </>
  );
}
