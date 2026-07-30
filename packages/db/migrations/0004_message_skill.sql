-- Records which skill answered a message.
--
-- Without this the admin panel can show a transcript but not which skill produced it, so
-- an owner tuning routing rules has no way to tell whether a question went where they
-- intended. Routing is configurable, and configuration you cannot observe is guesswork.
--
-- Nullable on purpose: messages predating this column have no answer, and a tenant with
-- no skills configured routes to null and still answers. A NOT NULL column would have
-- forced a fake "default skill" into the schema to represent "no routing happened".
ALTER TABLE messages ADD COLUMN skill_id uuid;

-- Composite, carrying tenant_id, for the same reason every other foreign key here does:
-- foreign key checks bypass row security, so a plain reference to skills(id) would let a
-- message point at another tenant's skill. This makes that structurally impossible.
ALTER TABLE messages
  ADD CONSTRAINT messages_skill_fk
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills(tenant_id, id) ON DELETE SET NULL;

-- SET NULL rather than CASCADE: deleting a skill must not delete the conversations it
-- answered. The transcript is the business's record of what its customers were told.

CREATE INDEX messages_skill_idx ON messages (tenant_id, skill_id);
