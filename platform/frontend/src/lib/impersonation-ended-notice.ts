/**
 * How viewing as another user ended without the admin asking for it:
 * `returned` is the app going back to the admin's own session shortly before
 * the impersonated one ran out; `signed-out` is that session running out
 * first, which leaves nobody signed in.
 */
type ImpersonationEnd = "returned" | "signed-out";

export const IMPERSONATION_ENDED_TEXT: Record<ImpersonationEnd, string> = {
  returned:
    "Viewing as another user ended: it lasts one hour at most. You are back in your own session.",
  "signed-out":
    "Viewing as another user ended: it lasts one hour at most. Sign in to continue.",
};

/**
 * Why the admin is suddenly somewhere else, kept for the page that shows
 * next. Either end replaces what is on screen (a reload, or the sign-in
 * page), and a toast raised before that is lost with it.
 */
export const impersonationEndedNotice = {
  remember(end: ImpersonationEnd) {
    try {
      window.sessionStorage.setItem(ENDED_NOTICE_KEY, end);
    } catch {
      // Storage is unavailable: the end still happens, without the note.
    }
  },
  /** The end that happened just before this page, if any; asked once. */
  take(): ImpersonationEnd | null {
    try {
      const end = window.sessionStorage.getItem(ENDED_NOTICE_KEY);
      if (end === null) return null;
      window.sessionStorage.removeItem(ENDED_NOTICE_KEY);
      return end === "signed-out" ? "signed-out" : "returned";
    } catch {
      return null;
    }
  },
};

const ENDED_NOTICE_KEY = "archestra:impersonation-ended";
