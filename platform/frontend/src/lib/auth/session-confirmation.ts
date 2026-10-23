/**
 * Whether this page load has confirmed a signed-in session yet.
 *
 * The app renders optimistically on a session cookie, so its queries can run
 * before get-session answers. When the cookie turns out to be expired those
 * queries get 401s while the app is already on its way to the sign-in page;
 * toasting them would flash "sign in first" errors over a redirect. Until a
 * session with a user is confirmed, `handleApiError` keeps 401s quiet.
 */
class SessionConfirmation {
  private signedIn = false;

  /** Record what get-session answered: a user, or none. */
  set(signedIn: boolean): void {
    this.signedIn = signedIn;
  }

  isSignedIn(): boolean {
    return this.signedIn;
  }
}

export const sessionConfirmation = new SessionConfirmation();
