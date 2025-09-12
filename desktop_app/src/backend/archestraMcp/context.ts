/**
 * Context manager for Archestra MCP server
 * Stores the current chat context for MCP tool execution
 */
class ArchestraMcpContext {
  private currentChatId: number | null = null;

  /**
   * Set the current chat ID for MCP tool execution
   */
  setCurrentChatId(chatId: number | null) {
    this.currentChatId = chatId;
  }

  /**
   * Get the current chat ID
   */
  getCurrentChatId(): number | null {
    return this.currentChatId;
  }

  /**
   * Clear the current context
   */
  clear() {
    this.currentChatId = null;
  }
}

// Export singleton instance
export default new ArchestraMcpContext();
