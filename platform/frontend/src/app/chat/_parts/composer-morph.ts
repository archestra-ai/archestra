/**
 * Whether a conversation's docked composer should take part in the composer's
 * shared-element morph (`<ViewTransition name="chat-composer">`).
 *
 * The morph carries the centered new-chat (or project) composer down to the
 * conversation's bottom dock. Between two conversations the composer does not
 * move, and the morph only started a document view transition that held the
 * new composer's first frames on every switch. A conversation page asks once,
 * as it first renders: while another conversation page is still mounted (the
 * one being switched away from), it is a switch, not an arrival.
 */
class ComposerMorph {
  private mountedConversationComposers = 0;

  shouldMorph(): boolean {
    return this.mountedConversationComposers === 0;
  }

  /** Call from a conversation page's mount effect; returns its cleanup. */
  registerConversationComposer(): () => void {
    this.mountedConversationComposers += 1;
    return () => {
      this.mountedConversationComposers -= 1;
    };
  }
}

export const composerMorph = new ComposerMorph();
