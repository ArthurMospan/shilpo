import { McpUnauthorizedError } from './mcp';

/**
 * Runs an MCP operation, refreshing the token once if Silpo rejects it.
 *
 * `revoke` runs when nothing is left to try: the token could not be refreshed,
 * or Silpo rejected the refreshed token as well. The second case is real —
 * Silpo keeps issuing fresh tokens after the Silpo session behind the grant
 * has ended, and every one of them is refused, so only a new login helps.
 */
export async function withRefreshOnce<T>(
    token: string,
    operation: (token: string) => Promise<T>,
    refresh: () => Promise<string | null>,
    revoke: () => Promise<never>
): Promise<T> {
    try {
        return await operation(token);
    } catch (error) {
        if (!(error instanceof McpUnauthorizedError)) throw error;
    }

    const refreshed = await refresh();
    if (!refreshed) return revoke();
    try {
        return await operation(refreshed);
    } catch (error) {
        if (error instanceof McpUnauthorizedError) return revoke();
        throw error;
    }
}
