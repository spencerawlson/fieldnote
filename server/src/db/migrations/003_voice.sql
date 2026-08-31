-- Narrative voice: how the document refers to the person who did the work.
--
-- Previously the prompts spoke of "the author", which the model echoed into the
-- output — so a report about your own work read as though a third party were
-- describing you. Voice is a deliberate editorial choice, so it is stored
-- rather than inferred, and defaults to first person because the common case is
-- someone documenting their own work.
ALTER TABLE projects ADD COLUMN voice TEXT NOT NULL DEFAULT 'first-person';
ALTER TABLE reports  ADD COLUMN voice TEXT NOT NULL DEFAULT 'first-person';
ALTER TABLE presentations ADD COLUMN voice TEXT NOT NULL DEFAULT 'first-person';
