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

export interface OssTable {
  table_name: string;
}

export interface OssFunction {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface OssBucket {
  name: string;
}

// Deployment types (OSS - Vercel deployment)

export interface CreateDeploymentResponse {
  id: string;
  uploadUrl: string;
  uploadFields: Record<string, string>;
}

export interface SiteDeployment {
  id: string;
  status: string;
  provider: string;
  providerDeploymentId: string | null;
  // API returns "url"; some endpoints may use "deploymentUrl"
  url: string | null;
  deploymentUrl?: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentMetadata {
  currentDeploymentId: string | null;
  domain: string | null;
  slug: string | null;
  deploymentUrl: string | null;
}

export interface StartDeploymentRequest {
  projectSettings?: {
    buildCommand?: string | null;
    outputDirectory?: string | null;
    installCommand?: string | null;
    devCommand?: string | null;
    rootDirectory?: string | null;
  };
  envVars?: { key: string; value: string }[];
  meta?: Record<string, string>;
}
