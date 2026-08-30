import { DatabaseConfigurationError } from "./types.js";

const POSTGRES_SSL_URL_PARAMETERS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
] as const;

const POSTGRES_TLS_URL_PARAMETERS = [
  ...POSTGRES_SSL_URL_PARAMETERS,
  "sslnegotiation",
] as const;

/** Resolve the effective top-level pg ssl option without conflicting sources of truth. */
export function resolvePostgresPoolSsl(
  connectionString: string,
  profile: "postgres" | "supabase",
  explicitSsl: boolean | undefined,
  field = "connectionString",
): boolean | undefined {
  const hasUrlSslConfig = hasPostgresUrlSslConfiguration(connectionString, field);
  if (explicitSsl !== undefined && hasUrlSslConfig) {
    // pg-connection-string overrides PoolConfig.ssl with URL parameters.
    throw new DatabaseConfigurationError(
      `ssl cannot be combined with PostgreSQL TLS parameters in ${field}`,
    );
  }
  if (explicitSsl !== undefined) return explicitSsl;
  if (hasUrlSslConfig) return undefined;
  return profile === "supabase" ? true : undefined;
}

function hasPostgresUrlSslConfiguration(connectionString: string, field: string): boolean {
  let parameters: URLSearchParams;
  try {
    parameters = new URL(connectionString).searchParams;
  } catch {
    // Connection-string validation or pg itself will report the malformed URL.
    return false;
  }

  for (const parameter of POSTGRES_TLS_URL_PARAMETERS) {
    const values = parameters.getAll(parameter);
    if (values.length > 1) {
      throw new DatabaseConfigurationError(
        `PostgreSQL TLS parameter ${parameter} in ${field} must not be repeated`,
      );
    }
    if (values[0]?.trim().length === 0) {
      throw new DatabaseConfigurationError(
        `PostgreSQL TLS parameter ${parameter} in ${field} must not be empty`,
      );
    }
  }

  const sslNegotiation = parameters.get("sslnegotiation");
  if (sslNegotiation !== null
    && sslNegotiation !== "postgres"
    && sslNegotiation !== "direct") {
    throw new DatabaseConfigurationError(
      `PostgreSQL TLS parameter sslnegotiation in ${field} must be postgres or direct`,
    );
  }

  // The traditional `postgres` negotiation changes only the handshake. It
  // does not enable SSL, so a Supabase URL containing only that option must
  // retain the profile's secure default. `direct`, by contrast, makes
  // pg-connection-string enable SSL and is therefore a URL-level SSL source.
  return POSTGRES_SSL_URL_PARAMETERS.some((parameter) => parameters.has(parameter))
    || sslNegotiation === "direct";
}
