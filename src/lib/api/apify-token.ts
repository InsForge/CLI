import { ossFetch } from './oss.js';
import { CLIError } from '../errors.js';

/**
 * Fetch the Apify access token that InsForge holds on behalf of the user.
 *
 * Calls GET /api/datasources/apify/token on the project's OSS host using the
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
    res = await ossFetch('/api/datasources/apify/token');
  } catch (err) {
    if (err instanceof CLIError && err.statusCode === 404) {
      // A 404 here means either no Apify connection for this project, or the
      // backend has no /datasources/apify route at all (older or self-hosted
      // backends, where the data source is unsupported). Mention both so the
      // user is not sent to `connect` on a backend that can never connect.
      throw new CLIError(
        'Apify is not connected, or this backend does not have the Apify data source enabled (it is cloud-only). Run `insforge datasource apify connect` to connect.',
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
