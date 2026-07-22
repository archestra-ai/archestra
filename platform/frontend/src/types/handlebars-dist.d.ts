/*
 * Handlebars does not publish TypeScript declarations for the browser-friendly
 * `handlebars/dist/handlebars` subpath. We import that bundle in browser code
 * to avoid pulling in the Node-oriented entrypoint, which triggers Next/Webpack
 * warnings for unsupported `require.extensions` usage.
 */
declare module "handlebars/dist/handlebars" {
  import Handlebars from "handlebars";

  export default Handlebars;
}
