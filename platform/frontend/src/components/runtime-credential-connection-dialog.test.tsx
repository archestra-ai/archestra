import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RuntimeCredentialConnectionDialog } from "./runtime-credential-connection-dialog";

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@/lib/runtime-credentials.query", () => ({
  useStartGitHubUserConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useSetRuntimeCredentialConnection: () => ({
    mutate: mocks.mutate,
    isPending: false,
  }),
}));

describe("RuntimeCredentialConnectionDialog", () => {
  it("validates and connects a reusable personal credential", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConnected = vi.fn();
    mocks.mutate.mockImplementation(
      (_input: unknown, options: { onSuccess: () => void }) =>
        options.onSuccess(),
    );

    render(
      <RuntimeCredentialConnectionDialog
        definition={{
          kind: "secret",
          githubClientId: null,
          key: "github",
          name: "GitHub PAT",
          description: "Repository access",
          icon: "logo:github",
        }}
        scope="personal"
        onConnected={onConnected}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Secret value is required")).toBeVisible();
    expect(mocks.mutate).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Secret value"), "test-token");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        key: "github",
        name: "GitHub PAT",
        scope: "personal",
        value: "test-token",
      },
      expect.any(Object),
    );
    expect(onConnected).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("connects a GitHub App from a dropped .pem file, never a pasted one", async () => {
    const user = userEvent.setup();
    mocks.mutate.mockReset();
    render(
      <RuntimeCredentialConnectionDialog
        definition={{
          kind: "github_app",
          githubClientId: "Iv23-test",
          key: "lobster-app",
          name: "Lobster GitHub App",
          description: "",
          icon: null,
        }}
        scope="organization"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("textbox", { name: /private key/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Choose the private key file")).toBeVisible();

    const keyInput = screen.getByLabelText("Private key");
    await user.upload(
      keyInput,
      new File(["not a key"], "notes.pem", { type: "application/x-pem-file" }),
    );
    expect(
      await screen.findByText("That file is not a PEM private key"),
    ).toBeVisible();

    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n";
    await user.upload(
      keyInput,
      new File([pem], "app.private-key.pem", {
        type: "application/x-pem-file",
      }),
    );
    expect(await screen.findByText("app.private-key.pem")).toBeVisible();
    expect(screen.queryByText("That file is not a PEM private key")).toBeNull();
    await user.type(screen.getByLabelText("OAuth client secret"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        key: "lobster-app",
        name: "Lobster GitHub App",
        scope: "organization",
        value: JSON.stringify({
          privateKey: pem.trim(),
          clientSecret: "s3cret",
        }),
      },
      expect.any(Object),
    );
  });
});
