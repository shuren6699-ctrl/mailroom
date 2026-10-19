/** Language model for every text-generation AI feature, unless the workspace sets its own. */
export const DEFAULT_AI_MODEL = "openai/gpt-6-luna";
export const AI_MODEL_CATALOG_URL = "https://developers.cloudflare.com/ai/models/";

const MAX_MODEL_ID_CHARS = 200;
// Workers AI ids (`@cf/meta/llama-3.1-8b-instruct`) and catalog slugs (`openai/gpt-6-luna`).
const MODEL_ID_PATTERN = /^@?[A-Za-z0-9][\w.:-]*(\/[\w.:-]+)+$/;

/** Returns the normalized model id, null to use the default, or an error message. */
export function parseAiModel(value: unknown): { model: string | null } | { error: string } {
  if (value === null || value === undefined) return { model: null };
  if (typeof value !== "string") return { error: "The model must be text" };
  const model = value.trim();
  if (!model) return { model: null };
  if (model.length > MAX_MODEL_ID_CHARS || !MODEL_ID_PATTERN.test(model)) {
    return { error: "Enter a model id like openai/gpt-6-luna or @cf/meta/llama-3.1-8b-instruct" };
  }
  return { model };
}
