import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useK8sCapabilities } from "@/lib/environment.query";
import { AgentNetworkPolicyField } from "./agent-network-policy-field";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/environment.query", () => ({ useK8sCapabilities: vi.fn() }));

type Policy = Parameters<typeof AgentNetworkPolicyField>[0]["value"];

const CUSTOM: NonNullable<Policy> = {
  egressMode: "restricted",
  domainPreset: "none",
  allowedDomains: [],
  allowedCidrs: [],
};

function Harness({
  initial,
  onChange,
}: {
  initial: Policy;
  onChange: (value: Policy) => void;
}) {
  const [value, setValue] = useState<Policy>(initial);
  return (
    <AgentNetworkPolicyField
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      disabled={false}
    />
  );
}

describe("AgentNetworkPolicyField", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as never);
    vi.mocked(useK8sCapabilities).mockReturnValue({
      data: {
        networkPolicy: {
          supportsFqdn: true,
          enforcementStatus: "verified-enforced",
        },
      },
    } as never);
  });

  test("an inheriting agent shows no egress rules of its own", () => {
    render(<Harness initial={null} onChange={vi.fn()} />);

    expect(screen.getByText("Inherit from environment")).toBeInTheDocument();
    expect(screen.queryByLabelText("Allowed domains")).not.toBeInTheDocument();
  });

  test("typed domains reach the policy parsed, while the text keeps what was typed", () => {
    const onChange = vi.fn();
    render(<Harness initial={CUSTOM} onChange={onChange} />);

    const domains = screen.getByLabelText("Allowed domains");
    fireEvent.change(domains, {
      target: { value: "api.example.com\n api.example.com\n" },
    });

    expect(onChange).toHaveBeenLastCalledWith({
      ...CUSTOM,
      allowedDomains: ["api.example.com"],
    });
    expect(domains).toHaveValue("api.example.com\n api.example.com\n");
  });

  test("someone who cannot update environments sees the policy but cannot change it", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as never);
    render(<Harness initial={CUSTOM} onChange={vi.fn()} />);

    expect(
      screen.getByText(
        "Changing it requires permission to update environments.",
      ),
    ).toBeInTheDocument();
    for (const combobox of screen.getAllByRole("combobox")) {
      expect(combobox).toBeDisabled();
    }
    expect(screen.getByLabelText("Allowed domains")).toBeDisabled();
  });
});
