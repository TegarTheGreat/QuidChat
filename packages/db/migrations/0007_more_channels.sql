-- Slack and LINE join the channels a business can connect from the panel.
--
-- The CHECK constraint is the reason this migration exists rather than nothing: it named the four
-- channels that existed when the table was written, so saving Slack credentials would have been
-- refused by the database with a message written for an operator, on a screen used by a shop
-- owner. Keeping the constraint and widening it is still right — a typo'd channel produces a row
-- no webhook will ever match, and a channel nobody can reach looks exactly like one nobody
-- configured.
ALTER TABLE channel_configs DROP CONSTRAINT channel_configs_channel_check;
ALTER TABLE channel_configs ADD CONSTRAINT channel_configs_channel_check
  CHECK (channel IN ('telegram', 'whatsapp', 'waha', 'discord', 'slack', 'line'));
