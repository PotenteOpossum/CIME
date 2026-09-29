import dotenv from 'dotenv';

dotenv.config();

const localOrigins = [
  'http://localhost:5173', 'http://localhost:5174',
  'http://127.0.0.1:5173', 'http://127.0.0.1:5174'
];
const configuredOrigins = (process.env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
const jwtSecret = process.env.JWT_SECRET || '';
if (jwtSecret.length < 32) {
  throw new Error('Set JWT_SECRET to a randomly generated value of at least 32 characters in backend/.env. See README.md.');
}

export const DEFAULT_PRIMARY_MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-sol';
export const DEFAULT_CHEAP_MODEL = process.env.CHEAP_MODEL?.trim() || 'gpt-5.6-luna';
export const SUPPORTED_CHAT_MODELS = [...new Set([
  DEFAULT_PRIMARY_MODEL, DEFAULT_CHEAP_MODEL,
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o-mini'
])];

export const env = {
  port: Number(process.env.PORT || 4000),
  jwtSecret,
  openaiApiKey: process.env.CIME_API_KEY || process.env.OPENAI_API_KEY || '',
  openaiModel: DEFAULT_PRIMARY_MODEL,
  cheapModel: DEFAULT_CHEAP_MODEL,
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  corsOrigins: configuredOrigins.length ? configuredOrigins : localOrigins,
  botTriggerHandle: process.env.BOT_TRIGGER_HANDLE || '@bot'
};
