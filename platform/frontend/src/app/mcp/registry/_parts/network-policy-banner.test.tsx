import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkPolicyFields } from "./environments-section";

type Props = Parameters<typeof NetworkPolicyFields>[0];

function renderFields(overrides: Partial<Props> = {}) {
  return render(
    <NetworkPolicyFields
      egressMode="restricted"
      setEgressMode={() => {}}
      domainPreset="none"
      setDomainPreset={() => {}}
      allowedDomainsText=""
      setAllowedDomainsText={() => {}}
      allowedCidrsText=""
      setAllowedCidrsText={() => {}}
      supportsFqdn={true}
      enforcementStatus="verified-enforced"
      baselineLoaded={true}
      disabled={false}
      {...overrides}
    />,
  );
}

/** The egress mode Select is the control the enforcement banners gate. */
function egressSelect() {
  return screen.getAllByRole("combobox")[0];
}

describe("network policy banners", () => {
  it("warns and freezes the controls when a probe measured no enforcement", () => {
    renderFields({ enforcementStatus: "verified-not-enforced" });

    expect(
      screen.getByText("Network policy enforcement test failed"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Network policy enforcement not verified"),
    ).not.toBeInTheDocument();
    expect(egressSelect()).toBeDisabled();
  });

  it("notes the gap but keeps the controls usable when nothing measured", () => {
    renderFields({ enforcementStatus: "unknown" });

    expect(
      screen.getByText("Network policy enforcement not verified"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Network policy enforcement test failed"),
    ).not.toBeInTheDocument();
    // The regression this split exists for: an unmeasured cluster used to be
    // treated as a measured failure and had its egress editor locked.
    expect(egressSelect()).toBeEnabled();
  });

  it("treats capabilities that have not loaded as unverified, not as failure", () => {
    renderFields({ enforcementStatus: null });

    expect(
      screen.getByText("Network policy enforcement not verified"),
    ).toBeInTheDocument();
    expect(egressSelect()).toBeEnabled();
  });

  it("shows no enforcement banner once a probe confirmed enforcement", () => {
    renderFields({ enforcementStatus: "verified-enforced" });

    expect(
      screen.queryByText("Network policy enforcement test failed"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Network policy enforcement not verified"),
    ).not.toBeInTheDocument();
    expect(egressSelect()).toBeEnabled();
  });

  it("keeps the enforcement verdict ahead of the baseline and FQDN notices", () => {
    // All three conditions hold at once; only the most severe may render, or the
    // user is told the rules are ignored and that domains are unavailable in the
    // same breath.
    renderFields({
      enforcementStatus: "verified-not-enforced",
      baselineLoaded: false,
      supportsFqdn: false,
    });

    expect(
      screen.getByText("Network policy enforcement test failed"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Organization default not loaded"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Domain allowlists unavailable"),
    ).not.toBeInTheDocument();
  });

  it("falls through to the baseline notice when enforcement is confirmed", () => {
    renderFields({
      enforcementStatus: "verified-enforced",
      baselineLoaded: false,
    });

    expect(
      screen.getByText("Organization default not loaded"),
    ).toBeInTheDocument();
  });

  it("falls through to the FQDN notice when enforcement and baseline are fine", () => {
    renderFields({
      enforcementStatus: "verified-enforced",
      baselineLoaded: true,
      supportsFqdn: false,
    });

    expect(
      screen.getByText("Domain allowlists unavailable"),
    ).toBeInTheDocument();
  });

  it("shows no banner at all when everything is verified and loaded", () => {
    renderFields();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still honours the caller's own disabled flag while enforcement is fine", () => {
    renderFields({ enforcementStatus: "verified-enforced", disabled: true });

    expect(egressSelect()).toBeDisabled();
  });
});
