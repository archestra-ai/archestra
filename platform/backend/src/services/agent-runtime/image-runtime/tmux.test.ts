import { describe, expect, it } from "vitest";
import { runInContainer, sandboxImage } from "@/test/agent-runtime/docker";
import { buildImageRuntimeInstallScript } from "./bootstrap";

describe.skipIf(!sandboxImage)("tmux driver regressions", () => {
  it("never resolves a missing owned session to another session sharing its prefix", () => {
    const result = runInContainer(`
${buildImageRuntimeInstallScript()}
runtime=/var/run/archestra/runtime
tmux new-session -d -s agent-unrelated 'read line; touch /tmp/stolen-input; sleep 60'
for operation in ready alive capture geometry; do
  if "$runtime" "$operation"; then echo "Unexpected success: $operation" >&2; exit 1; fi
done
if "$runtime" submit 'must not reach another session'; then exit 1; fi
if "$runtime" attention 1 'must not mutate another session'; then exit 1; fi
if "$runtime" reset; then exit 1; fi
"$runtime" stop
"$runtime" stop
tmux has-session -t '=agent-unrelated'
test ! -f /tmp/stolen-input
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  });

  it("stops only the owned session", () => {
    const result = runInContainer(`
${buildImageRuntimeInstallScript()}
runtime=/var/run/archestra/runtime
"$runtime" initialize
tmux new-session -d -s unrelated 'sleep 60'
"$runtime" stop
if "$runtime" ready; then exit 1; fi
tmux has-session -t '=unrelated'
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  });

  it("repaints the owned frame after native detach and stop without losing literal exit text", () => {
    const result = runInContainer(`
${buildImageRuntimeInstallScript()}
runtime=/var/run/archestra/runtime
"$runtime" initialize
cat > /tmp/interactive.sh <<'SCRIPT'
printf 'VISIBLE-FINAL-FRAME\\n'
read line
printf 'SECOND-VIEWER-STILL-LIVE literal [exited]\\n'
sleep 60
SCRIPT
"$runtime" launch /tmp/interactive.sh
python3 /tmp/runtime-fixtures/tmux-repaint.py
"$runtime" initialize
test ! -f /var/run/archestra/runtime-terminal-final-frame
`);
    expect(result.status, result.stderr).toBe(0);
    const streams = (JSON.parse(result.stdout) as string[]).map((encoded) =>
      Buffer.from(encoded, "base64").toString("utf8"),
    );
    const repaint = "\u001b[?1049l\u001b[0m\u001b[H\u001b[2J";
    expect(streams[0].split(repaint).at(-1)).toContain("VISIBLE-FINAL-FRAME");
    const finalFrame = streams[1].split(repaint).at(-1);
    expect(finalFrame).toContain("VISIBLE-FINAL-FRAME");
    expect(finalFrame).toContain("SECOND-VIEWER-STILL-LIVE literal [exited]");
    expect(finalFrame?.match(/\[exited\]/g)).toHaveLength(1);
  });
});
