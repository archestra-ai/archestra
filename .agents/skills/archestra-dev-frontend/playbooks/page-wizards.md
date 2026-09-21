# Build or standardize a page wizard

Read when implementing page-based resource creation or configuration. First
choose the surface using [Form surfaces](../references/form-surfaces.md).
The baseline is agent creation. Keep the instructions here; inspect only the
linked implementation pieces needed for the current change.

## 1. Compose the shared page

- Use `PageWizard` for one or multiple steps. It owns the `PageLayout` width,
  header/back-link placement, scrolling, and optional compact `WizardStepper`.
  A single step or the source chooser renders without a stepper.
- Keep multi-step progress and earlier-step navigation visible on narrow screens.
  Use a compact row of step targets with the current label wrapping below it.
- Use `SettingsSectionGroup` and `SettingsSection`: subject/explanation on the
  left, controls on the right, separators between sections, stacked on mobile.
  Rich editors may take the full content width where they need it.
- Reuse these field sections on create and edit. Avoid local copies of panel
  borders, spacing, or footer positioning. A resource's file editor and its
  access controls should still read as named sections of the same form.
- Put `WizardFooter` in the form, or associate its submit button with `formId`.
  Keep backward/exit actions on the left and the primary action on the right.
  Form state and persistence belong to the feature; the shell is presentation.

## 2. Define the configuration steps

- Represent steps as a typed, ordered list with stable ids and useful labels.
  Split when it helps configuration; never manufacture steps to fill a stepper.
- Source/template/catalog selection is an optional prelude. Seed the draft
  once when the selection is accepted. Import/auth flows may retain their
  existing handoff, cancellation, and completion semantics.
- MCP keeps Configuration → Test → Tools across the save boundary. Show that
  sequence after source selection; testing requires the saved server id.
- One step goes directly to its Create/Connect/Save action. Multiple draft
  steps use the next destination as the button label and save on the final
  step, except when later setup requires a saved id as in MCP.
- Creation allows revisiting earlier steps. Reach later steps through their
  validated predecessor, including when using the stepper.
- Preserve direct access to an existing resource's configuration sections.
  A saved-resource setup flow may allow jumping to its independent steps.

## 3. Preserve the draft and make submission deliberate

- Keep one authoritative draft across steps, either in a stable form mount or
  in its owner. Back/Next must not reset fields, selections, labels, or files.
- Guard source changes that discard work. Going back without discarding data
  does not need a confirmation. Query refetches must not overwrite dirty input.
- Use native form submission. Back/Next and all secondary controls are
  `type="button"`; only persistence actions submit. Audit nested editor/dialog
  controls when introducing a form. Enter must not create before the save step.
  Key Next and Submit buttons separately when swapping them in the same slot,
  so the click that advances cannot also submit the newly rendered button.
- Check validity and write permission in the action/submit path as well as
  the button state. Disable competing actions while saving and prevent
  duplicate in-flight submissions.
- Leave the draft on screen after failure. For editors that stay open, record
  the submitted snapshot as saved; edits made during the request remain dirty.
  When success navigates away, freeze the submitted draft until it settles.
- Use event handlers for user actions and derive step/validity state directly.
  Reserve effects for external synchronization, with cleanup where needed.

## 4. Guard exits and finish deliberately

- Wire dirty state to `useUnsavedChangesGuard`, `useBeforeUnloadWhileDirty`,
  and `useGuardedInAppNavigation`. Cover the page back link, Cancel, and other
  in-app links. Keep Editing preserves the draft; Discard takes the intended
  destination. Check helper coverage before promising browser-history guards.
- Successful saves and explicit discard must bypass the old dirty guard.
  Do not prompt to discard a resource that was just saved, or allow it to be
  submitted again while its success destination is opening.
- Prefer final-submit creation. If later setup needs a saved id (MCP connection
  testing), preserve that boundary: Create saves, later steps configure/test
  the existing resource, and Finish navigates. Cancel does not undo saved work.
- Keep the appropriate completion destination: summary, connection instructions,
  detail page, or existing import result. Resolve read permission before sending
  a creator to a protected detail page; show success in place when needed.

## 5. Verify the experience

Exercise one-step and multi-step cases where affected: no unnecessary stepper,
Back/Next retains input, validation blocks progression, Enter cannot submit
early, failed saves preserve input, discard keeps/takes the intended destination,
and success neither prompts nor submits twice. Check desktop and narrow layouts
for visible steps, labelled sections, and a reachable footer. Test behavior at
the cheapest level that exercises it; do not assert copies of utility classes
or props.

## Focused implementation references

Paths below are relative to the repository root:

- `platform/frontend/src/components/page-wizard.tsx`: shared page/stepper shell.
- `platform/frontend/src/components/agent-pages/agent-create-page.tsx`: staged creation and permission-aware completion.
- `platform/frontend/src/components/settings-section.tsx`: section layout.
- `platform/frontend/src/components/wizard-footer.tsx`: action row.
- `platform/frontend/src/components/unsaved-changes-guard.tsx`: existing exit guards.
- `platform/frontend/src/app/mcp/registry/[id]/edit/page.client.tsx`: setup after persistence.
