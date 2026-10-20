import { describe, expect, it } from "vitest";
import {
  buildChannelFilesRequest,
  parseSharePointSites,
} from "./channel-files-request";

describe("parseSharePointSites", () => {
  it("trims a channel's folder link to its team site", () => {
    expect(
      parseSharePointSites(
        "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/General",
      ),
    ).toEqual(["https://contoso.sharepoint.com/sites/Engineering"]);
  });

  it("keeps one entry per site and skips links that are not team sites", () => {
    expect(
      parseSharePointSites(
        [
          "https://contoso.sharepoint.com/sites/Engineering",
          "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents",
          "https://contoso.sharepoint.com/teams/Support",
          "https://contoso-my.sharepoint.com/personal/alex_contoso_com/Documents",
          "https://example.com/sites/Engineering",
          "not a url",
        ].join("\n"),
      ),
    ).toEqual([
      "https://contoso.sharepoint.com/sites/Engineering",
      "https://contoso.sharepoint.com/teams/Support",
    ]);
  });
});

describe("buildChannelFilesRequest", () => {
  it("gives the admin a read grant command for every listed site", () => {
    const request = buildChannelFilesRequest({
      appId: "11111111-2222-3333-4444-555555555555",
      botName: "Acme Teams bot",
      sites: [
        "https://contoso.sharepoint.com/sites/Engineering",
        "https://contoso.sharepoint.com/sites/Support",
      ],
    });

    for (const site of ["Engineering", "Support"]) {
      expect(request).toContain(
        `m365 spo site apppermission add --siteUrl https://contoso.sharepoint.com/sites/${site} --appId 11111111-2222-3333-4444-555555555555 --permission read`,
      );
    }
    expect(request).toContain(
      "GET  https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Engineering?$select=id",
    );
    expect(request).toContain("Sites.Selected");
  });

  it("shows placeholders until a site is listed", () => {
    const request = buildChannelFilesRequest({
      appId: "11111111-2222-3333-4444-555555555555",
      botName: "Acme Teams bot",
      sites: [],
    });

    expect(request).toContain("- https://<tenant>.sharepoint.com/sites/<team>");
  });
});
