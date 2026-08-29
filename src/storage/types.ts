import type { SessionStore } from "../session.js";

export type DatabaseProfile = "postgres" | "supabase" | "sqlite";
export type DatabaseEngine = "postgres" | "sqlite";
export type DatabaseSelectionMode = "auto" | DatabaseProfile;
export type PostgresSchemaMode = "check" | "migrate";

export interface PostgresProfileConfig {
  connectionString: string;
  /** Optional elevated connection used only while applying schema migrations. */
  migrationConnectionString?: string;
  /** Production-safe default is check-only. */
  schemaMode?: PostgresSchemaMode;
  maxConnections?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

export interface SupabaseProfileConfig {
  /** Direct/session-pooler PostgreSQL URL. The Supabase Data API is not used. */
  databaseUrl: string;
  /** Optional elevated direct PostgreSQL URL used only for migrations. */
  migrationUrl?: string;
  /** Production-safe default is check-only. */
  schemaMode?: PostgresSchemaMode;
  maxConnections?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  /** Defaults to TLS unless the URL already contains PostgreSQL TLS parameters. */
  ssl?: boolean;
}

export interface SqliteProfileConfig {
  filename: string;
}

export type PostgresSchemaMigrationConfig =
  | {
      profile: "postgres";
      connectionString: string;
      ssl?: boolean;
      connectionTimeoutMillis?: number;
      idleTimeoutMillis?: number;
    }
  | {
      profile: "supabase";
      databaseUrl: string;
      /** Defaults to TLS unless databaseUrl contains PostgreSQL TLS parameters. */
      ssl?: boolean;
      connectionTimeoutMillis?: number;
      idleTimeoutMillis?: number;
    };

export interface SessionDatabaseConfig {
  mode?: DatabaseSelectionMode;
  /** Logical isolation key inside PostgreSQL. */
  namespace: string;
  postgres?: PostgresProfileConfig;
  supabase?: SupabaseProfileConfig;
  sqlite?: SqliteProfileConfig;
}

/** Safe startup diagnostic. Connection strings are deliberately omitted. */
export interface ResolvedDatabaseProfile {
  readonly profile: DatabaseProfile;
  readonly engine: DatabaseEngine;
  readonly namespace: string;
  readonly schemaMode?: PostgresSchemaMode;
  readonly ssl?: boolean;
  readonly ignoredProfiles: readonly DatabaseProfile[];
}

export interface ManagedSessionStore extends SessionStore {
  readonly profile: DatabaseProfile;
  readonly engine: DatabaseEngine;
  readonly namespace: string;
  readinessCheck(): Promise<void>;
  close(): Promise<void>;
}

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export class ManagedSessionStoreClosedError extends Error {
  constructor() {
    super("Session Store is closing or closed");
    this.name = "ManagedSessionStoreClosedError";
  }
}
