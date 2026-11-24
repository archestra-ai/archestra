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
   * `true` only where an Agent Runtime credential authenticated the session: a
   * new root it opens is unattended. `false` where the host verified the
   * request holds no runtime or delegated binding, so it cannot continue a
   * family a runtime opened. Absent where the host cannot tell.
   */
  agent_runtime?: boolean;
};
