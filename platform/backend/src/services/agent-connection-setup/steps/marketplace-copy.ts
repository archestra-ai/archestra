interface MarketplaceContents {
  hasSkills?: boolean;
  pluginNames?: readonly string[];
}

export function describeMarketplaceContents(contents: MarketplaceContents): {
  hasSkills: boolean;
  hasPlugins: boolean;
  label: string;
} {
  const hasSkills = contents.hasSkills ?? true;
  const hasPlugins = (contents.pluginNames?.length ?? 0) > 0;
  return {
    hasSkills,
    hasPlugins,
    label:
      hasSkills && hasPlugins
        ? "Skills + plugins marketplace"
        : hasPlugins
          ? "Plugins marketplace"
          : "Skills marketplace",
  };
}
