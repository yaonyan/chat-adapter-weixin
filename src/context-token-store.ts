/**
 * In-memory store for context_token values.
 *
 * WeChat requires that each reply echoes back the context_token from the
 * triggering message. This store keeps the latest token per user ID so
 * postMessage can look it up when composing a reply.
 */
export class ContextTokenStore {
  private readonly tokens = new Map<string, string>();

  set(userId: string, token: string): void {
    this.tokens.set(userId, token);
  }

  get(userId: string): string | undefined {
    return this.tokens.get(userId);
  }
}
