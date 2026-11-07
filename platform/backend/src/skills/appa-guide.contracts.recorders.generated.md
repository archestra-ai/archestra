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

### Recorder protocol

OpenAPPA sends a delivery after it records each batch of decisions and outcomes. A delivery is not a consult request, and it carries a label that OpenAPPA derived:

```json
{
  "version": 1,
  "kind": "recorder",
  "name": "file-tracker",
  "root": "cc:7f3a…",
  "records": [
    {
      "record": "released",
      "dispatch": "cc:7f3a…/9c1e…/0",
      "tool": "host/claude-code/Write",
      "arguments": { "file_path": "/work/notes.md", "content": "…" },
      "label": { "trust": "suspicious", "audience": [["internal"]] },
      "evidence": "absent"
    },
    { "record": "outcome", "dispatch": "cc:7f3a…/9c1e…/0", "outcome": "success" }
  ]
}
```

| Record | Fields | Meaning |
|---|---|---|
| `released` | `dispatch`, `tool`, `arguments`, `label`, `evidence` | OpenAPPA released the call. `label` is its published label. |
| `outcome` | `dispatch`, `outcome` | The call ended: `success`, `failure`, or `indeterminate`. |
| `unreleased` | `trajectory`, `batch`, `tool`, `arguments`, `evidence` | OpenAPPA decided the call's batch and did not release the call. |

`label.audience` is `"public"` or a list of clauses. Each clause is a list of audience entries; a reader belongs to the audience when every clause includes the reader. A single clause has the same form as an annotator's audience answer. `evidence` is the annotator's `evidence`, or `null`.

The recorder returns `{"version":1,"answer":{}}`. OpenAPPA delivers each family's records in log order, at least once. A failed delivery stays for the next one. After a restart, OpenAPPA delivers each family again from its start, so a recorder MUST ignore a `dispatch` it already recorded.
