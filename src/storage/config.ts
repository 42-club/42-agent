import {
  DatabaseConfigurationError,
  type DatabaseProfile,
  type DatabaseSelectionMode,
  type PostgresProfileConfig,
  type PostgresSchemaMode,
  type ResolvedDatabaseProfile,
  type SessionDatabaseConfig,
  type SqliteProfileConfig,
  type SupabaseProfileConfig,
} from "./types.js";
import { resolvePostgresPoolSsl } from "./postgres-tls.js";

const PROFILE_PRIORITY = ["postgres", "supabase", "sqlite"] as const;
const SELECTION_MODES = new Set<DatabaseSelectionMode>(["auto", ...PROFILE_PRIORITY]);
const SCHEMA_MODES = new Set<PostgresSchemaMode>(["check", "migrate"]);

interface ValidatedPostgresProfile {
  profile: "postgres";
  engine: "postgres";
  connectionString: string;
  migrationConnectionString?: string;
  schemaMode: PostgresSchemaMode;
  maxConnections: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
}

interface ValidatedSupabaseProfile {
  profile: "supabase";
  engine: "postgres";
  connectionString: string;
  migrationConnectionString?: string;
  schemaMode: PostgresSchemaMode;
  maxConnections: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  ssl?: boolean;
  migrationSsl?: boolean;
}

interface ValidatedSqliteProfile {
  profile: "sqlite";
  engine: "sqlite";
  filename: string;
}

export type ValidatedDatabaseSelection =
  | ValidatedPostgresProfile
  | ValidatedSupabaseProfile
  | ValidatedSqliteProfile;

interface ValidatedConfiguration {
  namespace: string;
  selected: ValidatedDatabaseSelection;
  ignoredProfiles: DatabaseProfile[];
}

export function resolveSessionDatabaseConfig(
  config: SessionDatabaseConfig,
): ResolvedDatabaseProfile {
  const validated = validateAndSelect(config);
  const selected = validated.selected;
  const resolved: ResolvedDatabaseProfile = {
    profile: selected.profile,
    engine: selected.engine,
    namespace: validated.namespace,
    ignoredProfiles: Object.freeze([...validated.ignoredProfiles]),
    ...(selected.engine === "postgres" ? { schemaMode: selected.schemaMode } : {}),
    ...(selected.profile === "supabase" && selected.ssl !== undefined
      ? { ssl: selected.ssl }
      : {}),
  };
  return Object.freeze(resolved);
}

/** Internal factory input. Do not log: it contains database credentials. */
export function selectSessionDatabaseConfig(config: SessionDatabaseConfig): {
  namespace: string;
  selected: ValidatedDatabaseSelection;
} {
  const validated = validateAndSelect(config);
  return { namespace: validated.namespace, selected: validated.selected };
}

function validateAndSelect(config: SessionDatabaseConfig): ValidatedConfiguration {
  if (!isRecord(config)) throw new DatabaseConfigurationError("Database config must be an object");
  const namespace = validateNamespace(config.namespace);
  const mode = config.mode ?? "auto";
  if (!SELECTION_MODES.has(mode)) {
    throw new DatabaseConfigurationError("Database mode must be auto, postgres, supabase, or sqlite");
  }

  const profiles = new Map<DatabaseProfile, ValidatedDatabaseSelection>();
  if (Object.hasOwn(config, "postgres")) {
    profiles.set("postgres", validatePostgres(config.postgres));
  }
  if (Object.hasOwn(config, "supabase")) {
    profiles.set("supabase", validateSupabase(config.supabase));
  }
  if (Object.hasOwn(config, "sqlite")) {
    profiles.set("sqlite", validateSqlite(config.sqlite));
  }

  const selectedProfile = mode === "auto"
    ? PROFILE_PRIORITY.find((profile) => profiles.has(profile))
    : mode;
  if (!selectedProfile || !profiles.has(selectedProfile)) {
    throw new DatabaseConfigurationError(
      mode === "auto"
        ? "At least one complete postgres, supabase, or sqlite profile is required"
        : `Database mode ${mode} requires a complete ${mode} profile`,
    );
  }

  return {
    namespace,
    selected: profiles.get(selectedProfile)!,
    ignoredProfiles: PROFILE_PRIORITY.filter(
      (profile) => profile !== selectedProfile && profiles.has(profile),
    ),
  };
}

function validatePostgres(value: PostgresProfileConfig | undefined): ValidatedPostgresProfile {
  if (!isRecord(value)) incomplete("postgres");
  return {
    profile: "postgres",
    engine: "postgres",
    connectionString: validatePostgresUrl(value.connectionString, "postgres.connectionString"),
    migrationConnectionString: optionalPostgresUrl(
      value.migrationConnectionString,
      "postgres.migrationConnectionString",
    ),
    schemaMode: validateSchemaMode(value.schemaMode, "postgres"),
    maxConnections: validatePositiveInteger(value.maxConnections, 10, "postgres.maxConnections"),
    connectionTimeoutMillis: validatePositiveInteger(
      value.connectionTimeoutMillis,
      5_000,
      "postgres.connectionTimeoutMillis",
    ),
    idleTimeoutMillis: validateNonNegativeInteger(
      value.idleTimeoutMillis,
      30_000,
      "postgres.idleTimeoutMillis",
    ),
  };
}

function validateSupabase(value: SupabaseProfileConfig | undefined): ValidatedSupabaseProfile {
  if (!isRecord(value)) incomplete("supabase");
  return {
    profile: "supabase",
    engine: "postgres",
    connectionString: validatePostgresUrl(value.databaseUrl, "supabase.databaseUrl"),
    migrationConnectionString: optionalPostgresUrl(value.migrationUrl, "supabase.migrationUrl"),
    schemaMode: validateSchemaMode(value.schemaMode, "supabase"),
    maxConnections: validatePositiveInteger(value.maxConnections, 10, "supabase.maxConnections"),
    connectionTimeoutMillis: validatePositiveInteger(
      value.connectionTimeoutMillis,
      5_000,
      "supabase.connectionTimeoutMillis",
    ),
    idleTimeoutMillis: validateNonNegativeInteger(
      value.idleTimeoutMillis,
      30_000,
      "supabase.idleTimeoutMillis",
    ),
    ssl: validateSupabaseSsl(value.databaseUrl, value.ssl, "supabase.databaseUrl"),
    migrationSsl: validateSupabaseSsl(
      value.migrationUrl ?? value.databaseUrl,
      value.ssl,
      value.migrationUrl === undefined ? "supabase.databaseUrl" : "supabase.migrationUrl",
    ),
  };
}

function validateSqlite(value: SqliteProfileConfig | undefined): ValidatedSqliteProfile {
  if (!isRecord(value)) incomplete("sqlite");
  if (typeof value.filename !== "string" || value.filename.trim().length === 0) {
    throw new DatabaseConfigurationError("sqlite.filename must be a non-empty string");
  }
  return { profile: "sqlite", engine: "sqlite", filename: value.filename };
}

function validateNamespace(value: unknown): string {
  if (typeof value !== "string"
    || value.trim().length === 0
    || value.length > 255
    || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new DatabaseConfigurationError(
      "Database namespace must be a non-empty, well-formed Unicode string of at most 255 characters",
    );
  }
  return value;
}

function validatePostgresUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatabaseConfigurationError(`${field} must be a PostgreSQL connection URL`);
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || parsed.hostname.length === 0
      || parsed.pathname.length <= 1) {
      throw new Error("invalid PostgreSQL URL");
    }
  } catch {
    throw new DatabaseConfigurationError(`${field} must be a PostgreSQL connection URL`);
  }
  return value;
}

function optionalPostgresUrl(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : validatePostgresUrl(value, field);
}

function validateSupabaseSsl(
  databaseUrl: unknown,
  value: unknown,
  field: string,
): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new DatabaseConfigurationError("supabase.ssl must be a boolean");
  }
  return resolvePostgresPoolSsl(
    String(databaseUrl),
    "supabase",
    value as boolean | undefined,
    field,
  );
}

function validateSchemaMode(value: unknown, profile: DatabaseProfile): PostgresSchemaMode {
  const mode = value ?? "check";
  if (typeof mode !== "string" || !SCHEMA_MODES.has(mode as PostgresSchemaMode)) {
    throw new DatabaseConfigurationError(`${profile}.schemaMode must be check or migrate`);
  }
  return mode as PostgresSchemaMode;
}

function validatePositiveInteger(value: unknown, defaultValue: number, field: string): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || Number(resolved) <= 0) {
    throw new DatabaseConfigurationError(`${field} must be a positive integer`);
  }
  return Number(resolved);
}

function validateNonNegativeInteger(value: unknown, defaultValue: number, field: string): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 0) {
    throw new DatabaseConfigurationError(`${field} must be a non-negative integer`);
  }
  return Number(resolved);
}

function incomplete(profile: DatabaseProfile): never {
  throw new DatabaseConfigurationError(`Declared ${profile} profile is incomplete or invalid`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
