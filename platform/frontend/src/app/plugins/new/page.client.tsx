"use client";

import { POPULAR_PLUGIN_MARKETPLACES } from "@archestra/shared";
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  GitBranch,
  Github,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { DownloadFilesButton } from "@/components/file-workspace/download-files-button";
import { FilterBar } from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { Separator } from "@/components/ui/separator";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useSession } from "@/lib/auth/auth.query";
import { useCreatePlugin, usePlugins } from "@/lib/plugins/plugin.query";
import { ImportMarketplaceDialog } from "../_parts/import-marketplace-dialog";
import {
  blankPluginDraft,
  isPluginDraftDirty,
  OWN_PLUGIN_NAME_TAKEN,
  type PluginDraft,
  patchNewPluginDraft,
  pluginDraftGap,
  pluginNameTwin,
} from "../_parts/plugin-draft";
import { PluginForm } from "../_parts/plugin-form";
import { PluginBackLink } from "../_parts/plugin-page-shell";

const NEW_PLUGIN_PATH = "/plugins/new";

type CreateStep = "source" | "configure";

const CREATE_STEPS: Array<{ id: CreateStep; title: string }> = [
  { id: "source", title: "Source" },
  { id: "configure", title: "Configure" },
];

const STEP_DESCRIPTIONS: Record<CreateStep, string> = {
  source: "Import from GitHub or GitLab, or start blank.",
  // The whole plugin is on one page, so the sentence names the whole of it —
  // and the plugin's own page says the same thing over the same form.
  configure:
    "Add the files this plugin installs, and choose who can discover it.",
};

export default function NewPluginPage() {
  return (
    <div className="h-full w-full">
      <ErrorBoundary>
        <NewPluginWizard />
      </ErrorBoundary>
    </div>
  );
}

function NewPluginWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialSource = searchParams.get("source");
  const activeSection =
    searchParams.get("tab") === "permissions" ? "permissions" : "general";
  const [importState, setImportState] = useState<{
    repoUrl: string;
    autoDiscover: boolean;
  } | null>(
    initialSource === "marketplace"
      ? { repoUrl: "", autoDiscover: false }
      : null,
  );
  const [search, setSearch] = useState("");

  // The step lives in the URL together with the tab. Kept in state beside a
  // tab in the URL, the two drifted: going back to Source left
  // `tab=permissions` behind, and the next visit to Configure opened on it.
  const step: CreateStep =
    initialSource === "blank" || searchParams.has("tab")
      ? "configure"
      : "source";
  const stepIndex = CREATE_STEPS.findIndex((s) => s.id === step);
  const goToSource = () => router.push(NEW_PLUGIN_PATH);
  const goToConfigure = () => router.push(`${NEW_PLUGIN_PATH}?source=blank`);

  const [blankDraft] = useState<PluginDraft>(blankPluginDraft);
  const [draft, setDraft] = useState<PluginDraft>(blankDraft);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const patchDraft = (patch: Partial<PluginDraft>) =>
    setDraft((prev) => patchNewPluginDraft(prev, patch));

  const createPlugin = useCreatePlugin();
  const {
    data: plugins,
    isPending: isPluginsPending,
    isFetching: isPluginsFetching,
  } = usePlugins();
  // With no plugin to list, this page is where Plugins opens. It then says
  // what a plugin is, and has no list to go back to.
  const isFirstPlugin = plugins?.length === 0;
  // Held until that is known, so the source cards do not jump down when the
  // explanation arrives above them.
  const isFirstPluginUnknown = isPluginsPending && isPluginsFetching;
  const { data: session } = useSession();
  const nameTaken = pluginNameTwin({
    displayName: draft.displayName,
    clientType: draft.clientType,
    ownerId: session?.user?.id,
    // A successful create refreshes the list while this page is still up, on
    // its way to the new plugin. The list then holds the plugin just created,
    // which carries the draft's name and owner: without leaving it out, the
    // draft was told its own name was taken.
    pluginId: createPlugin.data?.id,
    plugins: plugins ?? [],
  });
  const draftGap =
    pluginDraftGap({ draft, isGithubPlugin: false }) ??
    (nameTaken === "own" ? OWN_PLUGIN_NAME_TAKEN : null);

  // The draft exists only on this page, so every way off it asks first. The
  // wizard's own steps and tabs keep the draft and pass straight through.
  const [isLeavingAfterCreate, setIsLeavingAfterCreate] = useState(false);
  const isDirty =
    !isLeavingAfterCreate && isPluginDraftDirty(draft, blankDraft);
  useBeforeUnloadWhileDirty(isDirty);
  const pendingHrefRef = useRef<string | null>(null);
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) router.push(href);
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      if (href.split(/[?#]/)[0] === NEW_PLUGIN_PATH) {
        router.push(href, { scroll: false });
        return;
      }
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard, router],
  );
  useGuardedInAppNavigation({ isDirty, onRequestNavigate: requestNavigate });

  const handleCreate = async () => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? draft.labels;
    // A handled failure resolves to null and a rejection is reported by the
    // mutation's own `onError`; both keep the page where it is with the draft
    // intact, so the author can retry without retyping.
    const created = await createPlugin
      .mutateAsync({
        displayName: draft.displayName.trim(),
        icon: draft.icon,
        description: draft.description,
        clientType: draft.clientType,
        supportedPlatforms: draft.supportedPlatforms,
        initialGrants: draft.initialGrants.map(({ subject, actions }) => ({
          subject,
          actions,
        })),
        files: draft.files,
        labels: finalLabels,
      })
      .catch(() => null);
    if (!created) return;
    setIsLeavingAfterCreate(true);
    router.push(`/plugins/${created.id}`);
  };

  const openImport = () => setImportState({ repoUrl: "", autoDiscover: false });
  const importPopular = (repoUrl: string) =>
    setImportState({ repoUrl, autoDiscover: true });
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
      <PageLayout
        title="Add a new plugin"
        description={STEP_DESCRIPTIONS[step]}
        backLink={
          isFirstPlugin && step === "source" ? undefined : (
            <PluginBackLink href="/plugins" label="Plugins" />
          )
        }
        tabs={
          step === "configure"
            ? [
                {
                  label: "General",
                  href: "/plugins/new?source=blank",
                  selected: activeSection === "general",
                },
                {
                  label: "Permissions",
                  href: "/plugins/new?source=blank&tab=permissions",
                  selected: activeSection === "permissions",
                },
              ]
            : []
        }
        mobileVisibleCount={2}
        actionButton={
          <div className="flex items-center gap-3">
            {step === "configure" && (
              <DownloadFilesButton
                name={draft.displayName || "plugin"}
                files={draft.files}
              />
            )}
            <WizardStepper
              compact
              steps={CREATE_STEPS}
              activeStep={step}
              onStepClick={(target) => {
                const targetIndex = CREATE_STEPS.findIndex(
                  (candidate) => candidate.id === target,
                );
                if (targetIndex < stepIndex) goToSource();
              }}
            />
          </div>
        }
        // The Plugins list's column (the layout's default), so the header,
        // its actions and the content keep their edges on the way in.
        contentOverflowX="clip"
      >
        <div className="space-y-6">
          {step === "source" && !isFirstPluginUnknown && (
            <div className="space-y-8">
              {isFirstPlugin && (
                <div className="max-w-2xl space-y-2">
                  <h2 className="text-lg font-semibold tracking-tight">
                    Extend your agent
                  </h2>
                  <p className="leading-relaxed text-pretty text-muted-foreground">
                    A plugin can bundle reusable instructions in form of skills,
                    executable scripts, and hooks in any combination to extend
                    functionality of your agent. Add ready plugins from
                    marketplaces or create your own. Then install with a single
                    command.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <CatalogSourceCard
                  icon={<GitBranch className="size-5" />}
                  title="Git repository"
                  description="GitHub or GitLab, public or private."
                  onClick={openImport}
                />
                <CatalogSourceCard
                  icon={<FileText className="size-5" />}
                  title="Blank template"
                  description="Write the plugin files here."
                  onClick={goToConfigure}
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
                            <UnstyledButton
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
                            </UnstyledButton>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {step === "configure" && (
            <div className="flex flex-col gap-4">
              <PluginForm
                draft={draft}
                onChange={patchDraft}
                labelsRef={labelsRef}
                activeSection={activeSection}
                nameTaken={nameTaken}
              />
              <WizardFooter>
                <Button variant="outline" onClick={goToSource}>
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                <PermissionButton
                  permissions={{ plugin: ["create"] }}
                  disabled={draftGap !== null || createPlugin.isPending}
                  tooltip={draftGap ?? undefined}
                  onClick={handleCreate}
                >
                  {createPlugin.isPending ? "Creating..." : "Create plugin"}
                </PermissionButton>
              </WizardFooter>
            </div>
          )}
        </div>
      </PageLayout>

      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
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
