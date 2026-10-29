import NewMcpCatalogItemPage from "./page.client";

/**
 * The client page guard refuses this route without registry create (its entry
 * in `requiredPagePermissionsMap`), before the form is offered.
 */
export default function NewMcpCatalogItemPageServer() {
  return <NewMcpCatalogItemPage />;
}
