import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { AudienceChip } from "@/components/audience-chip";

describe("AudienceChip", () => {
  test("names the owner in the same chip as the audience", () => {
    render(
      <AudienceChip
        audience="team"
        owner={{ id: "u1", name: "Ada Lovelace", email: "ada@x.invalid" }}
      />,
    );

    const chip = screen.getByRole("button", {
      name: "Audience: Team-wide, Owner: Ada Lovelace",
    });
    expect(chip).toHaveTextContent("Team-wide·Ada Lovelace");
  });

  test("keeps the owner's email one hover away, for contacting them", async () => {
    const user = userEvent.setup();
    render(
      <AudienceChip
        audience="org"
        owner={{ id: "u1", name: "Ada Lovelace", email: "ada@x.invalid" }}
      />,
    );

    await user.hover(screen.getByTestId("audience-chip"));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Owner: Ada Lovelace · ada@x.invalid",
    );
  });

  test("falls back to the email when the owner has no display name", () => {
    render(
      <AudienceChip
        audience="personal"
        owner={{ id: "u2", name: null, email: "runner@x.invalid" }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Audience: Personal, Owner: runner@x.invalid",
      }),
    ).toHaveTextContent("runner@x.invalid");
  });

  test("shows the audience alone when no owner is recorded", () => {
    render(<AudienceChip audience="personal" owner={null} />);

    const chip = screen.getByRole("button", { name: "Audience: Personal" });
    expect(chip).toHaveTextContent(/^Personal$/);
  });

  test("compact shows the owner and audience, one hover away", async () => {
    const user = userEvent.setup();
    render(
      <AudienceChip
        compact
        audience="team"
        owner={{ id: "u1", name: "Ada Lovelace", email: "ada@x.invalid" }}
      />,
    );

    await user.hover(
      screen.getByRole("button", {
        name: "Audience: Team-wide, Owner: Ada Lovelace",
      }),
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /^Ada LovelaceTeam-wide$/,
    );
  });
});
