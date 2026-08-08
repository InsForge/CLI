// What the backend's configured compute provider can actually do.
//
// Compute is no longer Fly-only: a self-hoster can run containers on their own
// Docker daemon instead, where there are no regions, no scale-to-zero, and source
// builds happen by uploading a context to the backend rather than by this CLI
// shelling out to flyctl. Sending a Fly-shaped request to that backend does not
// fail loudly — the region is simply recorded and ignored — so the CLI asks first.
//
// Reported as the `compute` slice of /api/metadata. The slice is absent on a
// backend older than it and when no driver is configured, so every field has to
// degrade to the Fly-shaped behaviour this CLI has always had.

import { ossFetch } from './api/oss.js';

export interface ComputeCapabilities {
  scaleToZero: boolean;
  regions: boolean;
  ingressModes: string[];
  sourceBuild: 'none' | 'flyctl' | 'context-upload';
  deployTokenIssuance: boolean;
}

/** Assumed shape for a backend that does not report capabilities: Fly. */
const LEGACY_FLY: ComputeCapabilities = {
  scaleToZero: true,
  regions: true,
  ingressModes: ['host'],
  sourceBuild: 'flyctl',
  deployTokenIssuance: true,
};

interface MetadataWithCompute {
  compute?: {
    defaultProvider?: string;
    providers?: Record<string, Partial<ComputeCapabilities>>;
  };
}

/**
 * Capabilities of the provider new services go to, plus its name.
 *
 * Never throws: a CLI that cannot deploy because a capability probe failed is
 * worse than one that tries the way it always has. `provider` is null when the
 * backend reported nothing, which callers can use to explain a fallback.
 */
export async function fetchComputeCapabilities(): Promise<{
  provider: string | null;
  capabilities: ComputeCapabilities;
}> {
  try {
    const res = await ossFetch('/api/metadata');
    const meta = (await res.json()) as MetadataWithCompute;
    const provider = meta.compute?.defaultProvider;
    const reported = provider ? meta.compute?.providers?.[provider] : undefined;
    if (!provider || !reported) {
      return { provider: null, capabilities: LEGACY_FLY };
    }
    // Field by field, so a backend that grows a capability this CLI does not know
    // about — or omits one it does — still yields a complete object.
    return {
      provider,
      capabilities: {
        scaleToZero: reported.scaleToZero ?? LEGACY_FLY.scaleToZero,
        regions: reported.regions ?? LEGACY_FLY.regions,
        ingressModes: reported.ingressModes ?? LEGACY_FLY.ingressModes,
        sourceBuild: reported.sourceBuild ?? LEGACY_FLY.sourceBuild,
        deployTokenIssuance:
          reported.deployTokenIssuance ?? LEGACY_FLY.deployTokenIssuance,
      },
    };
  } catch {
    return { provider: null, capabilities: LEGACY_FLY };
  }
}
