-- Reports gain a visual theme, matching what presentations already had.
--
-- The theme controls typography, accent colour and cover treatment across
-- every export format, so a report looks like the same document whether it is
-- opened as DOCX, PDF or HTML. It never affects content.
ALTER TABLE reports ADD COLUMN theme TEXT NOT NULL DEFAULT 'slate';
