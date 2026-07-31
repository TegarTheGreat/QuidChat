-- Trigram matching, for the words a language's grammar bends.
--
-- Indonesian affixes heavily: "garansi" is written "garansinya", "bergaransi", "garansinya";
-- "harga" becomes "harganya"; "kirim" becomes "pengiriman" and "dikirim". The keyword arm uses
-- the `'simple'` text-search configuration, which stems nothing — deliberately, because Postgres
-- ships no Indonesian dictionary and `'english'` would mangle it. So a customer asking "berapa
-- lama garansinya?" shares no token at all with a document that says "bergaransi resmi 12 bulan",
-- and the keyword arm cannot see the match however well it ranks what it does find.
--
-- Measured on that exact pair: `word_similarity('garansinya', <the warranty chunk>)` is 0.636,
-- against 0.182 for the payment chunk and 0.091 for the opening-hours one. The signal is clean
-- enough to rank on, which no amount of tuning the other two arms would have produced.
--
-- The index is what makes it affordable: `%>` (word similarity above the threshold) is an indexed
-- operator with `gin_trgm_ops`, so this is a lookup rather than a similarity computed against
-- every chunk the tenant owns.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS chunks_content_trgm ON chunks USING gin (content gin_trgm_ops);
