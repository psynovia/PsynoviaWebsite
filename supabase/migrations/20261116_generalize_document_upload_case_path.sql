-- Reuse the existing encrypted document-upload flow across case types.
-- Reject path traversal, enforce a UUID filename and tie the path to its case.
ALTER TABLE public.clinic_document_uploads_v2
  DROP CONSTRAINT clinic_document_uploads_v2_object_path_check;
ALTER TABLE public.clinic_document_uploads_v2
  ADD CONSTRAINT clinic_document_uploads_v2_object_path_check
  CHECK (
    split_part(object_path, '/', 1) = case_id
    AND object_path ~ '^[A-Za-z0-9_-]{1,80}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.enc$'
  );
