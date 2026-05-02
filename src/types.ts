// Platform API types

export interface User {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  email_verified: boolean;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface RefreshResponse {
  token: string;
}

export interface Organization {
  id: string;
  name: string;
  type: string;
  created_at: string;
  updated_at: string;
}

export interface OrgMembership {
  organization: Organization;
  role: string;
}

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  appkey: string;
  region: string;
  status: string;
  instance_type: string;
  service_version: string | null;
  customized_domain: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectAuthResponse {
  code: string;
  expires_in: number;
  type: string;
}

export interface ApiKeyResponse {
  access_api_key: string;
}

export interface DatabasePasswordResponse {
  databasePassword: string;
}

export interface ConnectionStringResponse {
  connectionURL: string;
  parameters: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    sslmode: string;
  };
}

// Stored credentials
export interface StoredCredentials {
  access_token: string;
  /**
   * Either an OAuth refresh token (opaque string) or a user API key
   * prefixed `uak_` (for PAT-based CLI logins). The `uak_` prefix is the
   * discriminator — see `isPatLogin()` in `lib/credentials.ts`.
   */
  refresh_token: string;
  user: User;
}

// Global config
export interface GlobalConfig {
  default_org_id?: string;
  platform_api_url: string;
  oauth_client_id?: string;
}

// Project config (local .insforge/project.json)
export interface ProjectConfig {
  project_id: string;
  project_name: string;
  org_id: string;
  appkey: string;
  region: string;
  api_key: string;
  oss_host: string;
  /** When set, this directory is currently switched onto a branch. Carries
   *  the original parent project's identifying fields so name → branch_id
   *  resolution and `branch switch --parent` know where to land back. */
  branched_from?: { project_id: string; project_name: string };
}

// --- Branching ---

export interface Branch {
  id: string;
  parent_project_id: string;
  organization_id: string;
  name: string;
  appkey: string;
  region: string;
  status?: string;
  branch_state: 'creating' | 'ready' | 'merging' | 'merged' | 'conflicted' | 'deleted' | 'resetting';
  branch_created_at: string;
  branch_metadata?: {
    mode: 'full' | 'schema-only';
    parent_t0?: unknown;
    source_backup_s3_key?: string;
  };
}

export type BranchMode = 'full' | 'schema-only';

export interface DiffChange {
  schema: string;
  object: string;
  type: 'table' | 'policy' | 'function' | 'config_row' | 'migration' | 'edge_function';
  action: 'add' | 'modify' | 'drop';
  sql: string;
}

export interface DiffConflict {
  schema: string;
  object: string;
  type: DiffChange['type'];
  parent_t0_hash: string;
  parent_now_hash: string;
  branch_now_hash: string;
  hint: string;
}

export interface DiffResult {
  summary: { added: number; modified: number; conflicts: number };
  /** Migration-file-style SQL preview, BEGIN/COMMIT-wrapped, with section
   *  headers ([DDL] / [DATA] / [MIGRATION]). On conflict, leads with a
   *  `-- ⚠️ MERGE BLOCKED` banner. Safe to print to stdout / save to file. */
  rendered_sql: string;
  changes: DiffChange[];
  conflicts: DiffConflict[];
}

export interface MergeExecuteResponse {
  branchId: string;
  status: 'merged';
  diff: DiffResult;
}

export interface MergeConflictResponse {
  code: string;
  error: string;
  requestId?: string;
  diff: DiffResult;
}

// API Error
export interface ApiError {
  code?: string;
  error: string;
  requestId?: string;
}

// OSS API types

export type { ListFunctionsResponse, StorageBucketSchema, ListDeploymentsResponse,
  DatabaseFunctionsResponse, DatabaseIndexesResponse, DatabasePoliciesResponse, DatabaseTriggersResponse,
  Migration, DatabaseMigrationsResponse, CreateMigrationRequest, CreateMigrationResponse,
  CreateScheduleResponse, ListSchedulesResponse, GetScheduleResponse, ListExecutionLogsResponse,
  ListSecretsResponse, GetSecretValueResponse, CreateSecretResponse, DeleteSecretResponse, UpdateSecretResponse,
  CreateDeploymentResponse, CreateDirectDeploymentRequest, CreateDirectDeploymentResponse,
  DeploymentManifestFileEntry, DeploymentManifestFile, UploadDeploymentFileResponse,
  StartDeploymentRequest, DeploymentSchema, DeploymentMetadataResponse
 } from '@insforge/shared-schemas';

// Function types (kept local: shared-schemas source defines FunctionResponse and
// DeploymentResult but the published npm package does not export them yet)

export interface FunctionDeploymentResult {
  id: string;
  status: 'success' | 'failed';
  url: string | null;
  buildLogs?: string[];
}

export interface FunctionResponse {
  success: true;
  message?: string;
  function: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    code: string;
    status: 'draft' | 'active' | 'error';
    createdAt: string;
    updatedAt: string;
    deployedAt: string | null;
  };
  deployment?: FunctionDeploymentResult | null;
}
