## Recorders

A recorder stores what a released call publishes, so that a later call can read it. For example, a file tracker records the label of each file a `Write` call writes. When a later `Read` call reads that file, the file tracker's annotator returns the stored label as the read's `delta`.

A tool selects one recorder with `recorder = "<name>"`, on a named contract or on the `"*"` wildcard. Configure the recorder under `[externals.recorders.<name>]` with `url` or `command`. The policy declares no `[[policy.recorder]]`; each recorder named on a tool MUST have a binding, and each binding MUST be named on a tool.

```toml
[[policy.annotator]]
name = "file-tracker"

[[policy.tool]]
name = "host/claude-code/Write"
annotator = "file-tracker"
recorder = "file-tracker"

[externals.annotators.file-tracker]
command = ["appa", "file-tracker", "annotate"]

[externals.recorders.file-tracker]
command = ["appa", "file-tracker", "record"]
```

A recorder is not consulted. It cannot deny, delay, or approve a call, and OpenAPPA does not wait for it. A recorder needs the same trust as an annotator: a recorder that stores a wrong label makes a later annotation wrong.

### Published label

The label a call publishes is the trajectory's label when OpenAPPA released the call, combined with the tool's `forwards` and `delta`. A write publishes all that the agent could put in its arguments. A copy publishes the source's label through `delta`, even though the trajectory does not receive the bytes. For a call that an input sanitizer rewrote, the trajectory's label is the label after the rewrite.
