import { ossFetch } from './oss.js';
import { CLIError } from '../errors.js';

/**
 * Fetch the Apify access token that InsForge holds on behalf of the user.
 *
 * Calls GET /api/webscraper/apify/token on the project's OSS host using the
 * admin `ik_` key (via ossFetch). Returns the token string on success.
 *
 * Throws a CLIError:
 * - If the project has no Apify connection (404 → human-readable message).
 * - If the response contains no token (corrupt state).
 * - Propagates any other ossFetch error (network, 401, etc.) as-is.
 */
export async function fetchApifyAccessToken(): Promise<string> {
  let res: Response;
  try {
    res = await ossFetch('/api/webscraper/apify/token');
  } catch (err) {
    // Only remap the backend's explicit "no connection" signal (resource-level
    // 404 with `error: 'not_connected'`) to the connect remediation. A bare
    // route-level 404 means the backend has no /webscraper route at all
    // (older/self-hosted, data source unsupported) — ossFetch already rewrites
    // that to a "not available on this backend" message, so let it propagate
    // rather than wrongly telling the user to run `connect`.
    if (err instanceof CLIError && err.statusCode === 404 && err.code === 'not_connected') {
      throw new CLIError(
        'Apify is not connected. Run `insforge webscraper apify connect` first.',
        1,
        'APIFY_NOT_CONNECTED',
        404,
      );
    }
    throw err;
  }

  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new CLIError(
      'Apify token endpoint returned no token; try reconnecting.',
      1,
      'APIFY_TOKEN_MISSING',
    );
  }
  return data.accessToken;
}
