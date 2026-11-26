/** Identity carried between the host and the OpenAPPA runtime. */
export type OpenAppaSession = {
  organization_id: string;
  caller_id?: string;
  session_id: string;
  parent_id?: string;
  /**
   * The session this one forks, on a new session whose history the proxy
   * traced to it: its first event opens a root of its own seeded from that
   * session's labels.
   */
  fork_of?: string;
  /**
   * Who presents the request, as the host authenticated it. The runtime refuses
   * an attended presenter any operation in a family an Agent Runtime opened.
   * Absent only where the host cannot tell; it reaches the runtime as unknown.
   */
  presenter?: OpenAppaPresenter;
};

/**
 * `runtime`: an Agent Runtime credential, whose new root is unattended.
 * `attended`: a request with no runtime or delegated binding, a user's
 * ordinary call. `delegated`: a binding the host signed into one family, a
 * spawned child or a peer proof. `unknown`: the host cannot tell.
 */
export type OpenAppaPresenter =
  | "runtime"
  | "attended"
  | "delegated"
  | "unknown";

/**
 * A review lookup's presenter: a session's, or `reviewer`, the host reading
 * for a person who rules on the family's offers without acting in it.
 */
export type OpenAppaReviewPresenter = OpenAppaPresenter | "reviewer";
