/**
 * The request boundary's word that the server just refused a request as
 * signed out (a 401). Both clients report here: the API client's response
 * interceptor and the auth client's error hook. So a refusal counts whatever
 * the caller does with it next, including a mutation that turns its error
 * into a `false` and never rejects. Whoever holds the session listens and
 * asks for it again; a report alone signs nobody out.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export const signedOutRefusal = {
  report() {
    for (const listener of listeners) listener();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
