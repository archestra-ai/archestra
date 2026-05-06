import { PageLayout } from "@/components/page-layout";

export default function RegistryV3Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title={
        <span className="flex items-center gap-2">
          MCP Registry
          <span className="text-sm font-normal text-muted-foreground">v3</span>
        </span>
      }
      description="Catalog presets, wired to real endpoints."
    >
      {children}
    </PageLayout>
  );
}
