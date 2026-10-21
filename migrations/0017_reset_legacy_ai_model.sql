-- The original default was not a Workers AI model available through the bound AI service.
-- Clear only that legacy value so existing installations use the native default.
UPDATE global_settings
SET ai_model = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE ai_model = 'openai/gpt-6-luna';
