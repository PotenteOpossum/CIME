import OpenAI from 'openai';
import { withModelBudget } from '../platform/modelBudget.js';
import { env } from '../config/env.js';
import { db } from '../config/db.js';
import { getWorkContext, throwIfWorkCancelled } from './workContext.js';

const openaiInstance = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

// GPT-5.6 models currently accept the default sampling configuration only.
// Older prompts still pass temperature, so strip that option centrally rather
// than requiring every agent implementation to know model-specific API rules.
export function normalizeChatCompletionParams(params = {}) {
  const normalized = { ...params };
  if (/^gpt-5\.6(?:-|$)/i.test(String(normalized.model || ''))) {
    delete normalized.temperature;
  }
  return normalized;
}

export function resolveLlmModel(caller, fallback) {
  const row = db.prepare('SELECT model_name FROM llm_call_models WHERE call_key = ?').get(caller);
  return row?.model_name || fallback;
}

function usageDetails(response, metadata) {
  const usage = response.usage || {};
  return {
    input: usage.prompt_tokens ?? usage.input_tokens ?? null,
    output: usage.completion_tokens ?? usage.output_tokens ?? null,
    cached: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? null,
    session: getWorkContext()?.sessionId ?? db.prepare('SELECT decision_run_id FROM system_state WHERE id = 1').get()?.decision_run_id ?? null,
    workType: getWorkContext()?.workType || metadata?.caller || 'unknown'
  };
}

export function createLoggedLlmClient(provider) {
  return {
  chat: {
    completions: {
      async create(params) {
        throwIfWorkCancelled();
        const { metadata, ...openaiParams } = params;
        
        try {
          const caller = metadata?.caller || 'unknown';
          if (!metadata?.modelResolved) openaiParams.model = resolveLlmModel(caller, openaiParams.model);
        } catch (err) {
          // Fallback silently if database or query is unavailable
        }

        const sessionUsage = usageDetails({}, metadata);
        const response = await withModelBudget(() => provider.chat.completions.create(normalizeChatCompletionParams(openaiParams), { signal: getWorkContext()?.signal }));
        
        try {
          let prompt = '';
          if (Array.isArray(openaiParams.messages)) {
            prompt = openaiParams.messages
              .map(m => `[${m.role}] ${m.content}`)
              .join('\n\n');
          } else {
            prompt = JSON.stringify(openaiParams.messages);
          }
          
          const responseText = response.choices?.[0]?.message?.content || '';
          const tokensUsed = response.usage?.total_tokens || null;
          const model = openaiParams.model;
          const roomId = metadata?.roomId || null;
          const caller = metadata?.caller || 'unknown';
          const usage = { ...usageDetails(response, metadata), session: sessionUsage.session };
          
          db.prepare(`
            INSERT INTO llm_logs (created_at, room_id, caller, prompt, response, tokens_used, model,
              input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, session_id, work_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            new Date().toISOString(),
            roomId,
            caller,
            prompt,
            responseText,
            tokensUsed,
            model, usage.input, usage.output, usage.cached, usage.reasoning, usage.session, usage.workType
          );
        } catch (err) {
          console.error('Failed to log LLM call:', err);
        }
        
        if (getWorkContext()?.isCurrent) throwIfWorkCancelled();
        return response;
      }
    }
  },
  embeddings: {
    async create(params) {
      throwIfWorkCancelled();
      const { metadata, ...openaiParams } = params;

      try {
        const caller = metadata?.caller || 'unknown';
        if (!metadata?.modelResolved) openaiParams.model = resolveLlmModel(caller, openaiParams.model);
      } catch (err) {
        // Fallback silently if database or query is unavailable
      }

      const sessionUsage = usageDetails({}, metadata);
      const response = await withModelBudget(() => provider.embeddings.create(openaiParams, { signal: getWorkContext()?.signal }));

      try {
        const caller = metadata?.caller || 'unknown';
        const roomId = metadata?.roomId || null;
        const prompt = Array.isArray(openaiParams.input)
          ? openaiParams.input.join('\n\n---\n\n')
          : String(openaiParams.input || '');
        const vectorCount = Array.isArray(response.data) ? response.data.length : 0;
        const dimensions = response.data?.[0]?.embedding?.length || null;
        const tokensUsed = response.usage?.total_tokens || null;
        const model = openaiParams.model;
        const usage = { ...usageDetails(response, metadata), session: sessionUsage.session };

        db.prepare(`
          INSERT INTO llm_logs (created_at, room_id, caller, prompt, response, tokens_used, model,
            input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, session_id, work_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          new Date().toISOString(),
          roomId,
          caller,
          prompt,
          JSON.stringify({ vectorCount, dimensions }),
          tokensUsed,
          model, usage.input, usage.output, usage.cached, usage.reasoning, usage.session, usage.workType
        );
      } catch (err) {
        console.error('Failed to log embedding call:', err);
      }

      if (getWorkContext()?.isCurrent) throwIfWorkCancelled();
      return response;
    }
  }
  };
}

export const client = openaiInstance ? createLoggedLlmClient(openaiInstance) : null;

export default client;
