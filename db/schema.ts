import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const clients = sqliteTable(
  "clients",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    site: text("site").notNull().default(""),
    niche: text("niche").notNull().default(""),
    primaryInfoStatus: text("primary_info_status").notNull().default("missing"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_clients_owner").on(table.ownerId)],
);

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    connector: text("connector").notNull(),
    status: text("status").notNull(),
    publicConfig: text("public_config").notNull().default("{}"),
    secretCipher: text("secret_cipher"),
    checkedAt: text("checked_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_connections_client_connector").on(
      table.clientId,
      table.connector,
    ),
  ],
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    note: text("note").notNull().default(""),
    url: text("url").notNull().default(""),
    rights: text("rights").notNull().default("unconfirmed"),
    approved: integer("approved", { mode: "boolean" }).notNull().default(false),
    isCanonical: integer("is_canonical", { mode: "boolean" })
      .notNull()
      .default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    canonicalStatus: text("canonical_status").notNull().default("candidate"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull().default(""),
  },
  (table) => [
    index("idx_sources_client").on(table.clientId),
    uniqueIndex("idx_sources_one_canonical")
      .on(table.clientId)
      .where(sql`${table.isCanonical} = 1`),
  ],
);
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    payload: text("payload").notNull().default("{}"),
    result: text("result"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: text("lease_until"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_jobs_status_created").on(table.status, table.createdAt),
    index("idx_jobs_client").on(table.clientId),
  ],
);
export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    connector: text("connector").notNull(),
    data: text("data").notNull(),
    retrievedAt: text("retrieved_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_snapshots_client_connector").on(
      table.clientId,
      table.connector,
    ),
  ],
);
export const logs = sqliteTable(
  "logs",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    detail: text("detail").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_logs_client_created").on(table.clientId, table.createdAt),
  ],
);
export const workerTokens = sqliteTable(
  "worker_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_worker_token_hash").on(table.tokenHash)],
);
export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  clientId: text("client_id").notNull(),
  ownerId: text("owner_id").notNull(),
  expiresAt: text("expires_at").notNull(),
});
export const appSettings = sqliteTable(
  "app_settings",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    settingKey: text("setting_key").notNull(),
    publicConfig: text("public_config").notNull().default("{}"),
    secretCipher: text("secret_cipher").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_app_settings_owner_key").on(
      table.ownerId,
      table.settingKey,
    ),
  ],
);
