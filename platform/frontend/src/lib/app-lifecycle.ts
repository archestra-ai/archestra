/**
 * Whether the app has rendered in this document yet. Code that runs as a
 * route's module loads can tell a full page load (nothing rendered yet) from
 * a client-side navigation (the app is already up).
 */
class AppLifecycle {
  private rendered = false;

  markRendered(): void {
    this.rendered = true;
  }

  get hasRendered(): boolean {
    return this.rendered;
  }
}

export const appLifecycle = new AppLifecycle();
