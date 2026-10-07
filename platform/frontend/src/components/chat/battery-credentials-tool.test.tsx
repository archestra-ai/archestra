import type { BatteryCredentialRequest } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import {
  BatteryCredentialsTool,
  parseBatteryCredentialRequest,
} from "./battery-credentials-tool";

// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

let credentials = [
  {
    id: "slack",
    key: "slack-token",
    name: "Slack token",
    allowOrganization: true,
    organizationConfigured: true,
  },
  {
    id: "personal",
    key: "my-token",
    name: "My token",
    allowOrganization: false,
    organizationConfigured: false,
  },
];
const created = {
  id: "new",
  key: "credential-github-token",
  name: "GitHub token",
  allowOrganization: true,
  organizationConfigured: false,
};

vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: () => ({ data: credentials }),
}));
vi.mock(
  "@/components/settings/runtime-credential-definition-dialog",
  async (importActual) => ({
    ...(await importActual<
      typeof import("@/components/settings/runtime-credential-definition-dialog")
    >()),
    RuntimeCredentialDefinitionDialog: ({
      initialValues,
      onCreated,
    }: {
      initialValues: { name: string };
      onCreated: (id: string) => void;
    }) => (
      <button
        type="button"
        onClick={() => {
          credentials = [...credentials, created];
          onCreated("new");
        }}
      >
        {`Create ${initialValues.name}`}
      </button>
    ),
  }),
);
vi.mock("@/components/runtime-credential-connection-dialog", () => ({
  RuntimeCredentialConnectionDialog: ({
    definition,
    onConnected,
    onClose,
  }: {
    definition: { name: string };
    onConnected: () => void;
    onClose: () => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onConnected();
        onClose();
      }}
    >
      {`Save secret for ${definition.name}`}
    </button>
  ),
}));

const request: BatteryCredentialRequest = {
  batteries: [
    {
      name: "slack",
      title: "Slack",
      benefit: "Slack benefit.",
      setup: ["Open https://api.slack.com/apps."],
      credentials: ["APPA_PROVIDER_SLACK_TOKEN"],
    },
    {
      name: "github",
      title: "GitHub",
      benefit: null,
      setup: [],
      credentials: ["APPA_PROVIDER_GITHUB_TOKEN"],
    },
  ],
};

beforeEach(() => {
  sessionStorage.clear();
  credentials = credentials.filter((entry) => entry.id !== created.id);
});

it("steps through batteries and sends the picked key or skip per variable on Done", async () => {
  const user = userEvent.setup();
  const onSendMessage = vi.fn();
  render(
    <BatteryCredentialsTool
      request={request}
      toolCallId="call-1"
      onSendMessage={onSendMessage}
    />,
  );
  const card = screen.getByTestId("battery-credentials-card");
  expect(card).toHaveTextContent("1 of 2");
  expect(screen.getByRole("region", { name: "Slack" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

  await user.click(screen.getByRole("combobox"));
  expect(screen.queryByRole("option", { name: "My token" })).toBeNull();
  await user.click(screen.getByRole("option", { name: "Slack token" }));
  await user.click(screen.getByRole("button", { name: "Next" }));

  expect(card).toHaveTextContent("2 of 2");
  expect(screen.getByRole("region", { name: "GitHub" })).toBeInTheDocument();
  const done = screen.getByRole("button", { name: "Done" });
  expect(done).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Skip APPA_PROVIDER_GITHUB_TOKEN" }),
  );

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("region", { name: "Slack" })).toHaveTextContent(
    "Slack token",
  );
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(onSendMessage).toHaveBeenCalledExactlyOnceWith(
    "Battery credentials: Slack APPA_PROVIDER_SLACK_TOKEN → slack-token; GitHub APPA_PROVIDER_GITHUB_TOKEN → skipped.",
  );
  expect(screen.getByRole("button", { name: "Sent" })).toBeDisabled();
});

it("selects a token added through the credential dialogs, with no counter for one battery", async () => {
  const user = userEvent.setup();
  const onSendMessage = vi.fn();
  render(
    <BatteryCredentialsTool
      request={{ batteries: [request.batteries[1]] }}
      toolCallId="call-2"
      onSendMessage={onSendMessage}
    />,
  );
  expect(screen.getByTestId("battery-credentials-card")).not.toHaveTextContent(
    "1 of 1",
  );

  await user.click(screen.getByRole("button", { name: "Add new token" }));
  await user.click(screen.getByRole("button", { name: "Create GitHub token" }));
  await user.click(
    screen.getByRole("button", { name: "Save secret for GitHub token" }),
  );
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(onSendMessage).toHaveBeenCalledExactlyOnceWith(
    "Battery credentials: GitHub APPA_PROVIDER_GITHUB_TOKEN → credential-github-token.",
  );
});

it("connects the definition an earlier attempt made instead of creating another", async () => {
  const user = userEvent.setup();
  const onSendMessage = vi.fn();
  credentials = [...credentials, created];
  render(
    <BatteryCredentialsTool
      request={{ batteries: [request.batteries[1]] }}
      toolCallId="call-3"
      onSendMessage={onSendMessage}
    />,
  );

  expect(screen.queryByRole("button", { name: "Add new token" })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Connect GitHub token" }),
  );
  expect(
    screen.queryByRole("button", { name: "Create GitHub token" }),
  ).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Save secret for GitHub token" }),
  );
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(onSendMessage).toHaveBeenCalledExactlyOnceWith(
    "Battery credentials: GitHub APPA_PROVIDER_GITHUB_TOKEN → credential-github-token.",
  );
});

it("reads the card's batteries from the tool result only when they are well formed", () => {
  expect(parseBatteryCredentialRequest({ structuredContent: request })).toEqual(
    request,
  );
  expect(
    parseBatteryCredentialRequest({ structuredContent: { batteries: [] } }),
  ).toBeNull();
  expect(parseBatteryCredentialRequest("Opened the card.")).toBeNull();
});
