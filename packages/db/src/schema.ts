import {
  index, integer, jsonb, pgTable, primaryKey,
  text, timestamp, unique, uuid, vector,
} from "drizzle-orm/pg-core"

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  chatModel: text("chat_model").notNull().default("claude-opus-5"),
  rewriteModel: text("rewrite_model").notNull().default("claude-opus-5"),
  embeddingModel: text("embedding_model").notNull().default("text-embedding-3-small"),
  refusalText: text("refusal_text").notNull()
    .default("Maaf, saya belum punya informasi itu. Boleh saya hubungkan ke tim kami?"),
  escalationMode: text("escalation_mode").notNull().default("collect_contact"),
  escalationTarget: text("escalation_target"),
  monthlyBudgetCents: integer("monthly_budget_cents").notNull().default(0),
  retentionDays: integer("retention_days").notNull().default(90),
  highRiskTopics: text("high_risk_topics").array().notNull()
    .default(["harga", "diskon", "garansi", "refund", "stok", "legal"]),
  allowedOrigins: text("allowed_origins").array().notNull().default([]),
  widgetTheme: jsonb("widget_theme").notNull().default({}),
  maxHandoffsPerTurn: integer("max_handoffs_per_turn").notNull().default(2),
  maxHandoffsPerConversation: integer("max_handoffs_per_conversation").notNull().default(5),
})

export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["url", "file", "text"] }).notNull(),
  uri: text("uri").notNull(),
  status: text("status", { enum: ["pending", "indexing", "ready", "error"] }).notNull().default("pending"),
  lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
  error: text("error"),
})

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => knowledgeSources.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  url: text("url"),
})

// NOTE: the `chunks` table in the database has one more column that is
// deliberately NOT modeled here — `tsv tsvector GENERATED ALWAYS AS
// (to_tsvector('simple', content)) STORED` — along with two indexes that only
// exist in the migration: `chunks_tsv_idx` (GIN on tsv) and `chunks_embed_idx`
// (HNSW on embedding). Reason: `tsv` is a generated column that's only ever
// read through raw SQL in the hybrid search query, so Drizzle doesn't need to
// know about it. Consequence: migrations/0001_init.sql is the source of truth
// for this table's shape — if you add a column or index to `chunks`, change
// the SQL too; this file alone isn't enough.
export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model").notNull(),
}, (t) => [index("chunks_tenant_idx").on(t.tenantId)])

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  visitorId: text("visitor_id").notNull(),
  handoffCount: integer("handoff_count").notNull().default(0),
  status: text("status", { enum: ["active", "idle", "escalated", "closed"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const messageCitations = pgTable("message_citations", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  chunkId: uuid("chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.messageId, t.chunkId] })])

export const escalations = pgTable("escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  reason: text("reason", {
    enum: ["no_source", "ungrounded", "budget_exhausted", "provider_unavailable",
           "schema_invalid", "handoff_limit", "visitor_request"],
  }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
})

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cachedTokens: integer("cached_tokens"),
  costCents: integer("cost_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("owner"),
  oauthProvider: text("oauth_provider"),
  oauthSubject: text("oauth_subject"),
}, (t) => [unique("admin_users_tenant_email_key").on(t.tenantId, t.email)])

export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  adminUserId: uuid("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
})
