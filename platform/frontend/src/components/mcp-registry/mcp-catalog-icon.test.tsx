import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";

vi.mock("next/image", () => ({
  default: ({
    alt,
    src,
    className,
    style,
  }: {
    alt: string;
    src: string;
    className?: string;
    style?: React.CSSProperties;
  }) => <img alt={alt} src={src} className={className} style={style} />,
}));

vi.mock("@/lib/hooks/use-app-name");

import { McpCatalogIcon } from "./mcp-catalog-icon";

describe("McpCatalogIcon", () => {
  it("pins the rendered image to the requested size, overriding Tailwind's img height:auto reset", () => {
    const { container } = render(
      <McpCatalogIcon icon="data:image/svg+xml;base64,abc" size={16} />,
    );

    const img = container.querySelector("img");
    expect(img).toHaveStyle({ width: "16px", height: "16px" });
  });

  it("pins the default Archestra logo to the requested size too", () => {
    vi.mocked(useAppIconLogo).mockReturnValue("/logo-icon.svg");

    const { container } = render(
      <McpCatalogIcon catalogId={ARCHESTRA_MCP_CATALOG_ID} size={24} />,
    );

    const img = container.querySelector("img");
    expect(img).toHaveStyle({ width: "24px", height: "24px" });
  });
});
