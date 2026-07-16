/**
 * PostgREST selects the target schema via a profile header: `Accept-Profile`
 * for reads and `Content-Profile` for writes/RPC. The table path stays bare.
 *
 * Returns the header(s) to send for a `--schema` option, or `{}` when it is
 * unset (the backend then uses its default schema, `public`).
 */
export function schemaProfileHeaders(
  kind: 'read' | 'write',
  schema?: string,
): Record<string, string> {
  if (!schema) return {};
  const header = kind === 'read' ? 'Accept-Profile' : 'Content-Profile';
  return { [header]: schema };
}
