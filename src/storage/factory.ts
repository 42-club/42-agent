import { selectSessionDatabaseConfig } from "./config.js";
import { migratePostgresSchema } from "./postgres-migrations.js";
import {
  PostgresSessionStore,
  type PostgresSessionStoreOptions,
} from "./postgres-session-store.js";
import { ManagedSqliteSessionStore } from "./sqlite-managed-session-store.js";
import type { ManagedSessionStore, SessionDatabaseConfig } from "./types.js";

/**
 * Opens exactly the selected profile. Connection or readiness failures never
 * fall through to a lower-priority database.
 */
export async function openSessionStore(
  config: SessionDatabaseConfig,
): Promise<ManagedSessionStore> {
  const { namespace, selected } = selectSessionDatabaseConfig(config);
  if (selected.engine === "sqlite") {
    const store = new ManagedSqliteSessionStore(selected.filename, namespace);
    return verifyOrClose(store);
  }

  const options: PostgresSessionStoreOptions = {
    connectionString: selected.connectionString,
    namespace,
    profile: selected.profile,
    maxConnections: selected.maxConnections,
    connectionTimeoutMillis: selected.connectionTimeoutMillis,
    idleTimeoutMillis: selected.idleTimeoutMillis,
    ...(selected.profile === "supabase" && selected.ssl !== undefined
      ? { ssl: selected.ssl }
      : {}),
  };
  if (selected.schemaMode === "migrate") {
    if (selected.profile === "supabase") {
      await migratePostgresSchema({
        profile: "supabase",
        databaseUrl: selected.migrationConnectionString ?? selected.connectionString,
        ...(selected.migrationSsl === undefined ? {} : { ssl: selected.migrationSsl }),
        connectionTimeoutMillis: selected.connectionTimeoutMillis,
        idleTimeoutMillis: selected.idleTimeoutMillis,
      });
    } else {
      await migratePostgresSchema({
        profile: "postgres",
        connectionString: selected.migrationConnectionString ?? selected.connectionString,
        connectionTimeoutMillis: selected.connectionTimeoutMillis,
        idleTimeoutMillis: selected.idleTimeoutMillis,
      });
    }
  }

  const store = new PostgresSessionStore(options);
  return verifyOrClose(store);
}

async function verifyOrClose<Store extends ManagedSessionStore>(store: Store): Promise<Store> {
  try {
    await store.readinessCheck();
    return store;
  } catch (error) {
    try {
      await store.close();
    } catch {
      // The readiness error is the actionable startup failure.
    }
    throw error;
  }
}
