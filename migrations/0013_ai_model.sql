-- Workers AI model id used by text-generation features. NULL uses the built-in default.
ALTER TABLE global_settings ADD COLUMN ai_model TEXT;
