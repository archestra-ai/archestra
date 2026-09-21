# Choose a form surface

Read before adding or changing a resource's create/edit experience.
Choose by the complexity of the form and what the user must do after submitting.
The complexity of the resource itself does not determine the size of its creation form.

## Modal form

Use a modal for a simple, bounded task: a small set of related inputs, little
branching, and one clear submission. Prefer `StandardFormDialog`; use
`FormDialog` directly when its body needs a different composition.

Also use a simple creation modal when the user must immediately continue in
the resource's workspace, where the real work cannot follow a setup sequence:

- Apps: collect a name, create, then open chat to build the app.
- Projects: collect initial metadata, create, then open the project workspace.
- Keys and small metadata edits: submit, then return to the surrounding context
  or show the required result, such as a key that can only be copied once.

Do not grow a modal into a large configuration workspace just because its first
version was small. Existing tabbed dialogs are precedents to assess, not a
requirement to reproduce for every resource.

## Page wizard

Use the shared page wizard for substantial configuration: multiple concerns,
conditional fields, access choices, rich editors, or setup that needs room.
Follow the [page wizard playbook](../playbooks/page-wizards.md).

- One configuration step: same component and footer, with the stepper hidden.
- Multiple useful stages: same component, with stepper and Back/Next navigation.
- Optional source/template selection precedes configuration; it does not need
  its own numbered step. A single Configure step stays a one-step wizard.
- Editing keeps direct access to the saved resource's sections. Reuse the page
  composition without forcing a return through creation or source selection.

Agents and MCP gateways use multiple configuration steps. Skills, plugins, and
external A2A agents can use one. MCP setup persists configuration before testing
the saved server; that persistence boundary must be explicit.

## Actions

Dedicated resource create/edit pages use `WizardFooter`, including one-step
wizards. Organization/account settings use `SettingsSaveBar` for pending changes.
These shared components own placement, spacing, and responsive behavior.
For a single independent value, an inline edit can remain in its surrounding
view; its save/cancel behavior must be clear.
