/**
 * An app's standalone run page, addressed by its custom slug when it has one
 * and by its id otherwise — `/a/<segment>` resolves either. Mirrors the
 * backend's `appRunUrl` so a link the model emits and a link the UI renders
 * point at the same place.
 *
 * This is a display URL only. The app runtime is mounted on the resolved
 * `app.id`, which stays the app's isolation key.
 */
export function appRunUrl(app: { id: string; slug?: string | null }): string {
  return `/a/${app.slug ?? app.id}`;
}
