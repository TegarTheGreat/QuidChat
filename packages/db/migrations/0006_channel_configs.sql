-- Per-tenant channel credentials, so connecting WhatsApp or Telegram is something a business
-- does in the panel rather than something an operator does by editing the environment and
-- restarting the process.
--
-- Environment variables still work and still take part: they are the right shape for one
-- business running its own instance, and for a shared deployment where every tenant talks to
-- the same bot. What they cannot express is two businesses on one installation each using
-- their own WhatsApp number — which is the whole point of being multi-tenant.
CREATE TABLE channel_configs (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The adapter id, matching `ChannelAdapter.id` in @quidchat/channels. Constrained here
  -- rather than left open: a typo would produce a row that silently never matches a webhook,
  -- and a channel nobody can reach looks identical to one nobody configured.
  channel    text NOT NULL CHECK (channel IN ('telegram', 'whatsapp', 'waha', 'discord')),
  -- Disabled rather than deleted is the useful state: a business testing a channel wants to
  -- turn it off without re-entering its credentials.
  enabled    boolean NOT NULL DEFAULT true,
  -- The credentials, encrypted as one blob rather than column-per-field. Each channel needs a
  -- different set (a bot token here, a phone number id and an app secret there), and a table
  -- with a nullable column for every field of every channel is a table where nothing is
  -- required and nothing is validated. The application knows the shape; the database only has
  -- to keep it secret.
  --
  -- Encrypted with AES-256-GCM under QUIDCHAT_SECRET_KEY — see packages/server/src/secrets.ts.
  -- Plaintext here would mean a database backup, a read replica, or a stray SELECT hands over
  -- the ability to send messages as the business.
  secrets    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);

-- The PK already covers (tenant_id, channel); this is the lookup the webhook route does on
-- every inbound message, and it wants only the tenant.
CREATE INDEX channel_configs_tenant_idx ON channel_configs (tenant_id);

ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_configs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
