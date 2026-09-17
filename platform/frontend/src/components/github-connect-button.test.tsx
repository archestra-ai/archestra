import { fireEvent, render, screen } from "@testing-library/react";
import { GitHubConnectButton } from "./github-connect-button";

it("prevents duplicate connections while pending and never submits an enclosing form by default", () => {
  const connect = vi.fn();
  const submit = vi.fn((event) => event.preventDefault());
  const view = (pending: boolean) => (
    <form onSubmit={submit}>
      <GitHubConnectButton pending={pending} onClick={connect} />
    </form>
  );
  const { rerender } = render(view(true));
  fireEvent.click(screen.getByRole("button", { name: "Connecting…" }));
  expect(connect).not.toHaveBeenCalled();
  rerender(view(false));
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  expect(connect).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});

it("can submit the shared connection dialog when explicitly used as its submit button", () => {
  const submit = vi.fn((event) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <GitHubConnectButton type="submit" />
    </form>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  expect(submit).toHaveBeenCalledOnce();
});
