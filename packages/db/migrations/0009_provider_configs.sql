-- Per-tenant AI provider credentials.
--
-- Giving the assistant a model is the single step without which nothing works at all, and until
-- now it was the one thing a business could not do for itself: an operator had to set an
-- environment variable and restart the process. That lands hardest on exactly the person this
-- product is for — a shop owner who can paste an API key into a form and cannot edit a systemd
-- unit. The panel is where configuration is supposed to live, and this was the largest hole in
-- that promise.
--
-- Environment variables still work and still matter. They are the right shape for one business
-- running its own instance, and for a shared deployment whose tenants all use the operator's key.
-- What they cannot express is two businesses on one installation each billing their own account —
-- which is the point of being multi-tenant.
CREATE TABLE provider_configs (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Which preset the tenant chose, when they want one that the search order would not pick on
  -- its own — Groq for answers while OpenAI does embeddings, say. NULL means "decide from the
  -- credentials present", which is what most tenants want.
  chat_provider  text,
  embed_provider text,
  -- The credentials, encrypted as one blob rather than a column per provider. Fourteen presets
  -- with a key and a base URL each is a table where nothing is required and nothing is
  -- validated; the application knows the shape, and the database only has to keep it secret.
  --
  -- Stored under the same env-variable names the presets already read (OPENAI_API_KEY,
  -- GROQ_API_KEY, OLLAMA_BASE_URL, …) so a tenant's credentials can be handed to exactly the
  -- resolver that reads the process environment, rather than to a second implementation of
  -- provider selection that would drift from it.
  --
  -- Encrypted with AES-256-GCM under QUIDCHAT_SECRET_KEY — see packages/server/src/secrets.ts.
  -- Plaintext here would mean a database backup or a stray SELECT hands over the ability to
  -- spend the business's money.
  secrets    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON provider_configs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
