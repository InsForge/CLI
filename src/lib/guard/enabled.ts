/**
 * Master on/off switch for the human-in-the-loop guard.
 *
 * The guard ships DISABLED by default so merging/publishing it is a no-op in
 * production — nobody's workflow changes until they opt in. `INSFORGE_GUARD` is
 * the source of truth: set it to turn the guard on (or force it off) regardless
 * of the default. When the feature is ready for GA, flip GUARD_DEFAULT_ENABLED
 * to `true` (or wire it to a remote/config flag).
 */

/** Default when INSFORGE_GUARD is unset. Off during rollout. */
export const GUARD_DEFAULT_ENABLED = false;

const ON = new Set(['1', 'true', 'on', 'yes', 'enabled']);
const OFF = new Set(['0', 'false', 'off', 'no', 'disabled']);

/**
 * Whether the guard should run. Precedence (source of truth, highest first):
 *   1. INSFORGE_GUARD env — override / kill switch
 *   2. persisted project setting (`link --guard`, stored in .insforge/project.json)
 *   3. shipped default (off during rollout)
 * Pure + injectable for testing.
 */
export function guardEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stored?: boolean | null,
): boolean {
  const v = (env.INSFORGE_GUARD ?? '').toString().trim().toLowerCase();
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  if (typeof stored === 'boolean') return stored;
  return GUARD_DEFAULT_ENABLED;
}
