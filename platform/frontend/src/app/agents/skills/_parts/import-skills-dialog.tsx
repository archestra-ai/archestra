"use client";

import type { archestraApiTypes } from "@shared";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useDiscoverGithubSkills,
  useImportGithubSkills,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";

type DiscoveredSkill =
  archestraApiTypes.DiscoverGithubSkillsResponses["200"]["skills"][number];

export function ImportSkillsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const discover = useDiscoverGithubSkills();
  const importSkills = useImportGithubSkills();

  const [repoUrl, setRepoUrl] = useState("");
  const [path, setPath] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredSkill[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reset = () => {
    setRepoUrl("");
    setPath("");
    setGithubToken("");
    setShowAdvanced(false);
    setDiscovered(null);
    setSelected(new Set());
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  };

  const handleDiscover = async () => {
    const result = await discover.mutateAsync({
      repoUrl,
      ...(path.trim() && { path: path.trim() }),
      ...(githubToken.trim() && { githubToken: githubToken.trim() }),
    });
    if (result) {
      setDiscovered(result.skills);
      setSelected(
        new Set(result.skills.filter((s) => !s.exists).map((s) => s.skillPath)),
      );
    }
  };

  const handleImport = async () => {
    const result = await importSkills.mutateAsync({
      repoUrl,
      ...(path.trim() && { path: path.trim() }),
      ...(githubToken.trim() && { githubToken: githubToken.trim() }),
      skillPaths: [...selected],
    });
    if (result) {
      handleClose(false);
    }
  };

  const toggle = (skillPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skillPath)) {
        next.delete(skillPath);
      } else {
        next.add(skillPath);
      }
      return next;
    });
  };

  const isSelectStep = discovered !== null;

  return (
    <StandardDialog
      open={open}
      onOpenChange={handleClose}
      title={
        isSelectStep ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setDiscovered(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span>Select skills to import</span>
          </div>
        ) : (
          "Import skills from GitHub"
        )
      }
      description={
        isSelectStep
          ? "Skills already in your organization are disabled."
          : "Point at a repository containing one or more SKILL.md directories."
      }
      size="medium"
      footer={
        isSelectStep ? (
          <>
            <Button variant="outline" onClick={() => setDiscovered(null)}>
              Back
            </Button>
            <Button
              onClick={handleImport}
              disabled={selected.size === 0 || importSkills.isPending}
            >
              {importSkills.isPending
                ? "Importing..."
                : `Import ${selected.size > 0 ? `(${selected.size})` : ""}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleDiscover}
              disabled={!repoUrl.trim() || discover.isPending}
            >
              {discover.isPending ? "Discovering..." : "Discover"}
            </Button>
          </>
        )
      }
    >
      {isSelectStep ? (
        <div className="space-y-3">
          {discovered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No SKILL.md directories found in that repository.
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {discovered.map((skill) => (
                  <li key={skill.skillPath}>
                    <button
                      type="button"
                      disabled={skill.exists}
                      onClick={() => toggle(skill.skillPath)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md border p-3 text-left",
                        skill.exists
                          ? "cursor-not-allowed opacity-60"
                          : "cursor-pointer hover:bg-muted/50",
                      )}
                    >
                      <Checkbox
                        checked={selected.has(skill.skillPath)}
                        disabled={skill.exists}
                        className="pointer-events-none"
                        tabIndex={-1}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{skill.name}</span>
                          {skill.compatibility && (
                            <Badge
                              variant="outline"
                              className="gap-1 text-amber-600 dark:text-amber-500"
                            >
                              <AlertTriangle className="h-3 w-3" />
                              runtime
                            </Badge>
                          )}
                          {skill.exists && (
                            <Badge variant="secondary">already exists</Badge>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {skill.description}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {skill.fileCount}{" "}
                        {skill.fileCount === 1 ? "file" : "files"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Scripts are imported as readable text — they are not executed.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="skill-repo-url">Repository URL</Label>
            <Input
              id="skill-repo-url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="github.com/anthropics/skills"
              autoFocus
            />
          </div>

          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "▾" : "▸"} Advanced (subpath, private token)
          </button>

          {showAdvanced && (
            <div className="space-y-4 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label htmlFor="skill-subpath">Subpath</Label>
                <Input
                  id="skill-subpath"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="skills"
                />
                <p className="text-xs text-muted-foreground">
                  Only scan SKILL.md directories under this path.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="skill-token">GitHub token</Label>
                <Input
                  id="skill-token"
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_… (for private repositories)"
                />
                <p className="text-xs text-muted-foreground">
                  Used only for this import and never stored.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </StandardDialog>
  );
}
