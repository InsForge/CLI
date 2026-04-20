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
