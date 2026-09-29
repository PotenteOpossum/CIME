# Message Proactiveness Analysis

You are classifying a human message in a deliberative decision process.

Decision question:
{{global_question}}

Additional context:
{{decision_context}}

General description:
{{general_description}}

Room name:
{{room_name}}

Current poll question:
{{poll_question}}

Current poll options:
{{poll_options}}

Current human message:
{{message_text}}

Messages immediately before this one:
{{recent_messages}}

{{previous_poll_options_block}}

Task:
Classify the message into exactly one of these categories:
- support
- opposition
- modification
- mitigation
- neutral

Return strict JSON with this schema:
{
  "label": "support" | "opposition" | "modification" | "mitigation" | "neutral",
  "confidence": number,
  "referenced_messages": [number]
}

Rules:
1. Use only the provided context.
2. "support" means the message endorses a baseline option without adding a new condition.
3. "opposition" means the message rejects or votes against a baseline option without adding a new condition.
4. "modification" means the message proposes a concrete change, condition, or adjustment to an option or proposal.
5. "mitigation" means the message softens, narrows, or makes an option safer, cheaper, easier, or less risky.
6. "neutral" means the message does not clearly support, oppose, modify, or mitigate an option.
7. If the message references a prior option or idea, cite the most relevant message ids in "referenced_messages" when available.
8. "confidence" must be a number between 0 and 1.
9. If you are uncertain, prefer "neutral" with lower confidence.

