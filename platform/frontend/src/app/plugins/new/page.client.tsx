"use client";

import {
  POPULAR_PLUGIN_MARKETPLACES,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import { ArrowLeft, ArrowRight, FileText, Github } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { FilterBar } from "@/components/filter-bar";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { Separator } from "@/components/ui/separator";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useFeature } from "@/lib/config/config.query";
import { useCreatePlugin } from "@/lib/plugins/plugin.query";
import { ImportMarketplaceDialog } from "../_parts/import-marketplace-dialog";
import {
  type PluginClientType,
  PluginContentFields,
  type PluginFileDraft,
} from "../_parts/plugin-content-fields";
import { PluginBackLink } from "../_parts/plugin-page-shell";
import type { PluginPlatform } from "../_parts/plugin-platforms";
import { PluginScopeSelector } from "../_parts/plugin-scope-selector";

type CreateStep = "source" | "content" | "access";

const CREATE_STEPS: Array<{ id: CreateStep; title: string }> = [
  { id: "source", title: "Source" },
  { id: "content", title: "Content" },
  { id: "access", title: "Access" },
];

const STEP_DESCRIPTIONS: Record<CreateStep, string> = {
  source: "Import from a GitHub marketplace or start from a blank template.",
  content:
    "Author the native hook configuration and any payload files the plugin needs.",
  access: "Choose who can discover and install the plugin.",
};

const INITIAL_FILES: PluginFileDraft[] = [
  {
    path: "hooks/hooks.json",
    content: "",
    encoding: "utf8",
    mode: "100644",
  },
];

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
    return <LoadingState label="Loading plugins…" variant="page" />;
  }

  if (!enabled) {
    return (
      <PageLayout
        title="Plugins"
        description="Plugins are disabled for this deployment."
        maxWidth="wizard"
      >
        <div />
      </PageLayout>
    );
  }

  return <NewPluginWizard />;
}

function NewPluginWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialSource = searchParams.get("source");
  const [importState, setImportState] = useState<{
    repoUrl: string;
    autoDiscover: boolean;
  } | null>(
    initialSource === "marketplace"
      ? { repoUrl: "", autoDiscover: false }
      : null,
  );
  const [search, setSearch] = useState("");

  const [step, setStep] = useState<CreateStep>(
    initialSource === "blank" ? "content" : "source",
  );
  const stepIndex = CREATE_STEPS.findIndex((s) => s.id === step);

  // The draft outlives the steps: content is written on one, access on the
  // next, and both go up together on create.
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [clientType, setClientType] = useState<PluginClientType>("claude-code");
  const [platforms, setPlatforms] = useState<PluginPlatform[]>([
    "posix",
    "windows",
  ]);
  const [files, setFiles] = useState<PluginFileDraft[]>(INITIAL_FILES);
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);

  const contentComplete = displayName.trim().length > 0 && files.length > 0;

  const createPlugin = useCreatePlugin();
  const handleCreate = async () => {
    // A handled failure resolves to null and a rejection is reported by the
    // mutation's own `onError`; both keep the wizard where it is with the
    // draft intact, so the author can retry without retyping.
    const created = await createPlugin
      .mutateAsync({
        displayName: displayName.trim(),
        description,
        clientType,
        supportedPlatforms: platforms,
        scope,
        teamIds: scope === "team" ? teamIds : [],
        userIds: scope === "personal" ? userIds : [],
        files,
      })
      .catch(() => null);
    if (created) router.push(`/plugins/${created.id}`);
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
        backLink={<PluginBackLink href="/plugins" label="Plugins" />}
        actionButton={
          <WizardStepper
            compact
            steps={CREATE_STEPS}
            activeStep={step}
            onStepClick={(target) => {
              const targetIndex = CREATE_STEPS.findIndex(
                (candidate) => candidate.id === target,
              );
              if (targetIndex < stepIndex) setStep(target);
            }}
          />
        }
        maxWidth="wizard"
      >
        <div className="space-y-6">
          {step === "source" && (
            <div className="mx-auto max-w-3xl space-y-8">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <CatalogSourceCard
                  icon={<Github className="size-5" />}
                  title="Custom GitHub URL"
                  description="Paste any repository with a plugin marketplace manifest."
                  onClick={openImport}
                />
                <CatalogSourceCard
                  icon={<FileText className="size-5" />}
                  title="Blank template"
                  description="Author native plugin files from scratch."
                  onClick={() => setStep("content")}
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
                  >
                    <SearchInput
                      value={search}
                      onSearchChange={setSearch}
                      syncQueryParams={false}
                      placeholder="Search marketplaces by name or use case..."
                      className="w-full flex-1"
                    />
                  </FilterBar>
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
          )}

          {step === "content" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border p-6">
                <PluginContentFields
                  displayName={displayName}
                  onDisplayNameChange={setDisplayName}
                  description={description}
                  onDescriptionChange={setDescription}
                  clientType={clientType}
                  onClientTypeChange={setClientType}
                  platforms={platforms}
                  onPlatformsChange={setPlatforms}
                  files={files}
                  onFilesChange={setFiles}
                />
              </div>
              <WizardFooter>
                <Button variant="outline" onClick={() => setStep("source")}>
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                <Button
                  disabled={!contentComplete}
                  onClick={() => setStep("access")}
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </WizardFooter>
            </div>
          )}

          {step === "access" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border p-6">
                <PluginScopeSelector
                  scope={scope}
                  onScopeChange={setScope}
                  teamIds={teamIds}
                  onTeamIdsChange={setTeamIds}
                  userIds={userIds}
                  onUserIdsChange={setUserIds}
                />
              </div>
              <WizardFooter>
                <Button variant="outline" onClick={() => setStep("content")}>
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                <PermissionButton
                  permissions={{ plugin: ["create", "admin"] }}
                  disabled={!contentComplete || createPlugin.isPending}
                  onClick={handleCreate}
                >
                  {createPlugin.isPending ? "Creating..." : "Create plugin"}
                </PermissionButton>
              </WizardFooter>
            </div>
          )}
        </div>
      </PageLayout>

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
