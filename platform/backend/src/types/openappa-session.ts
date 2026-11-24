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
   * Set only where the session was authenticated by an Agent Runtime credential.
   * A new root it opens takes the line `personApproval = auto_unattended` gives
   * unattended sessions; a child or fork follows its family's line instead.
   */
  agent_runtime?: true;
};
