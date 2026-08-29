import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../src/session-file.js";
import { SqliteSessionStore } from "../src/session-sqlite.js";
import { InMemorySessionStore, type SessionStore } from "../src/session.js";
import {
  defineSessionStoreContract,
  type SessionStoreContractFixture,
} from "./session-store-contract.js";

defineSessionStoreContract({
  name: "InMemory",
  async createFixture() {
    const store = new InMemorySessionStore();
    return {
      store,
      async reopen() {
        // In-memory state has no external resource to close or reopen.
        return store;
      },
      async close() {},
    };
  },
});

defineSessionStoreContract({
  name: "File",
  async createFixture() {
    const directory = await mkdtemp(join(tmpdir(), "42-agent-store-contract-file-"));
    let store = new FileSessionStore(directory);
    return {
      store,
      async reopen() {
        store = new FileSessionStore(directory);
        return store;
      },
      async close() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  },
});

defineSessionStoreContract({
  name: "SQLite",
  async createFixture() {
    const directory = await mkdtemp(join(tmpdir(), "42-agent-store-contract-sqlite-"));
    const filename = join(directory, "sessions.sqlite");
    let store = new SqliteSessionStore(filename);
    let open = true;

    return {
      store,
      async reopen() {
        if (open) await closeStore(store);
        store = new SqliteSessionStore(filename);
        open = true;
        return store;
      },
      async close() {
        if (open) {
          await closeStore(store);
          open = false;
        }
        await rm(directory, { recursive: true, force: true });
      },
    } satisfies SessionStoreContractFixture;
  },
});

async function closeStore(store: SessionStore): Promise<void> {
  const close = (store as SessionStore & { close?: () => void | Promise<void> }).close;
  if (close) await close.call(store);
}
