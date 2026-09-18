import { describe, expect, it } from "vitest";
import { runInContainer, sandboxImage } from "@/test/agent-runtime/docker";
import { buildImageRuntimeInstallScript } from "./bootstrap";

function terminalConformance(driver: {
  label: string;
  image?: string;
  setup: string;
  user?: string;
}) {
  describe.skipIf(!driver.image)(driver.label, () => {
    for (const [scenario, behavior] of [
      ["input", "preserves literal input and reports the resized terminal"],
      [
        "viewers",
        "keeps the same process alive when one of two viewers leaves",
      ],
    ]) {
      it(behavior, () => {
        const result = runInContainer(
          `${driver.setup}
${buildImageRuntimeInstallScript()}
python3 /tmp/runtime-fixtures/conformance.py ${scenario}`,
          { image: driver.image, user: driver.user },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("VERIFIED");
      }, 30_000);
    }
  });
}

terminalConformance({
  label: "default terminal",
  image: sandboxImage,
  setup: "",
});

// This exercises the external selection boundary with the same known driver.
// A Herdr image must run these same cases before claiming behavioral parity.
terminalConformance({
  label: "explicit external terminal entrypoint",
  image: sandboxImage,
  user: "0:0",
  setup: `mkdir -p /etc/archestra
cat > /tmp/runtime-bin/external-terminal <<'DRIVER'
#!/bin/sh
exec /bin/sh /tmp/runtime-source/drivers/tmux.sh "$@"
DRIVER
chmod 755 /tmp/runtime-bin/external-terminal
printf '%s\\n' /tmp/runtime-bin/external-terminal > /etc/archestra/terminal-driver`,
});
