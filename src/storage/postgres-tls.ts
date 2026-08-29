import { DatabaseConfigurationError } from "./types.js";

const POSTGRES_TLS_URL_PARAMETERS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslnegotiation",
] as const;

/** Resolve the effective top-level pg ssl option without conflicting sources of truth. */
export function resolvePostgresPoolSsl(
  connectionString: string,
  profile: "postgres" | "supabase",
  explicitSsl: boolean | undefined,
  field = "connectionString",
): boolean | undefined {
  const hasUrlTlsConfig = hasPostgresTlsParameters(connectionString);
  if (explicitSsl !== undefined && hasUrlTlsConfig) {
    // pg-connection-string overrides PoolConfig.ssl with URL parameters.
    throw new DatabaseConfigurationError(
      `ssl cannot be combined with PostgreSQL TLS parameters in ${field}`,
    );
  }
  if (explicitSsl !== undefined) return explicitSsl;
  if (hasUrlTlsConfig) return undefined;
  return profile === "supabase" ? true : undefined;
}

function hasPostgresTlsParameters(connectionString: string): boolean {
  try {
    const parameters = new URL(connectionString).searchParams;
    return POSTGRES_TLS_URL_PARAMETERS.some((parameter) => parameters.has(parameter));
  } catch {
    // Connection-string validation or pg itself will report the malformed URL.
    return false;
  }
}
