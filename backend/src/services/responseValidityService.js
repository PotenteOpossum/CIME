import client from './llm.js';
import { getDecisionSettings, getConfiguredModels } from './agentConfigService.js';

function normalizeText(text) {
  return String(text || '').trim();
}

export async function evaluateResponseValidity({
  text,
  questionText = '',
  roomContext = '',
  options = []
}) {
  const settings = getDecisionSettings();
  if (!settings.check_response_validity) {
    return { is_valid: true, reason: 'disabled', confidence: 1 };
  }

  const rawText = normalizeText(text);
  if (!rawText) {
    return { is_valid: false, reason: 'empty response', confidence: 1 };
  }

  if (!client) {
    return { is_valid: true, reason: 'no llm client available', confidence: 0.5 };
  }

  try {
    const response = await client.chat.completions.create({
      model: getConfiguredModels().cheapModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You are a strict response validator.',
            'Decide if the user message is a complete, real answer relevant to the question, or if it is nonsense, random text, incomplete, or unrelated filler.',
            'The user may ask a clarifying question about the bot question. A genuine clarification question is valid chat and should return true.',
            'Return JSON exactly in this shape: {"is_valid": boolean, "reason": string}.',
            'Be conservative: if the message is a plausible answer, even if short, return true.',
            'CRITICAL: If the user gives a contrary answer (e.g. "none", "no benefit", "I disagree with the premise"), this IS a valid answer! Do not flag it as a refusal.',
            'Return false for clearly nonsensical, irrelevant, evasive content, or noticeably incomplete/cut-off sentences (e.g. "it should be implemented only on").'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: questionText,
            room_context: roomContext,
            answer: rawText,
            options
          })
        }
      ]
    });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    if (typeof parsed.is_valid === 'boolean') {
      return {
        is_valid: parsed.is_valid,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'llm classification',
        confidence: 0.7
      };
    }
  } catch (error) {
    console.error('Response validity check failed, defaulting to valid:', error);
  }

  return { is_valid: true, reason: 'fallback', confidence: 0.5 };
}
