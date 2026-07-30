import { ossFetch } from './oss.js';
import { CLIError } from '../errors.js';

export interface ApifyTokenStatus {
  configured: boolean;
  maskedKey: string | null;
}

/**
 * Store a developer-supplied Apify API token on a self-hosted InsForge backend.
 *
 * Calls PUT /api/webscraper/apify/config on the project's OSS host. The backend
 * validates the token against Apify before saving, so a 400 here means the token
 * is bad — or that this is a cloud project, where the connection is made by OAuth
 * instead. Both arrive as a CLIError from ossFetch carrying the backend's message,
 * so they are left to propagate unchanged.
 */
export async function storeApifyToken(apiToken: string): Promise<ApifyTokenStatus> {
  const res = await ossFetch('/api/webscraper/apify/config', {
    method: 'PUT',
    body: JSON.stringify({ apiToken }),
  });

  const data = (await res.json()) as { token?: ApifyTokenStatus };
  if (!data.token) {
    throw new CLIError(
      'Apify config endpoint returned no token status; try again.',
      1,
      'APIFY_CONFIG_MALFORMED',
    );
  }
  return data.token;
}
