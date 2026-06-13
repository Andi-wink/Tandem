-- Add Mistral Voxtral API key column to transcript_settings
-- Voxtral is a cloud transcription provider (Mistral AI).
ALTER TABLE transcript_settings ADD COLUMN mistralApiKey TEXT;
