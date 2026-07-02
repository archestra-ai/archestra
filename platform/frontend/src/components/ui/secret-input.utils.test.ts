import { describe, expect, it } from "vitest";
import { SECRET_FIELD_SUPPRESSION_PROPS } from "./secret-input.utils";

describe("SECRET_FIELD_SUPPRESSION_PROPS", () => {
  it("declares autocomplete off — 'new-password' invites Chrome's strong-password generator", () => {
    expect(SECRET_FIELD_SUPPRESSION_PROPS.autoComplete).toBe("off");
  });

  it("opts out of 1Password, LastPass, Bitwarden, and Dashlane", () => {
    expect(SECRET_FIELD_SUPPRESSION_PROPS["data-1p-ignore"]).toBe(true);
    expect(SECRET_FIELD_SUPPRESSION_PROPS["data-lpignore"]).toBe("true");
    expect(SECRET_FIELD_SUPPRESSION_PROPS["data-bwignore"]).toBe("true");
    expect(SECRET_FIELD_SUPPRESSION_PROPS["data-form-type"]).toBe("other");
  });

  it("disables text assistance that would mangle pasted secrets", () => {
    expect(SECRET_FIELD_SUPPRESSION_PROPS.autoCapitalize).toBe("off");
    expect(SECRET_FIELD_SUPPRESSION_PROPS.autoCorrect).toBe("off");
    expect(SECRET_FIELD_SUPPRESSION_PROPS.spellCheck).toBe(false);
  });

  it("never sets type — components hardcode type='text', the attribute that keeps password managers away", () => {
    expect("type" in SECRET_FIELD_SUPPRESSION_PROPS).toBe(false);
  });
});
