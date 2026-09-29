# Custom Option Analysis

You are analyzing a custom option suggested by a user during a deliberative poll.

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

Custom option to classify:
{{custom_option_text}}

Messages before this poll:
{{recent_messages}}

{{previous_poll_options_block}}

Task:
Decide whether the custom option mainly:
- extends an earlier idea already present in the chat
- contradicts or rejects an earlier idea
- combines two or more earlier ideas
- is unrelated to the earlier discussion

Also classify whether it is:
- support
- opposition
- modification
- mitigation
- neutral

Return strict JSON with this schema:
{
  "reciprocity": {
    "is_reciprocal": boolean,
    "type": "extension" | "contradiction" | "combination" | "unrelated",
    "confidence": number,
    "referenced_messages": [number]
  },
  "constructive": {
    "label": "support" | "opposition" | "modification" | "mitigation" | "neutral",
    "confidence": number,
    "referenced_messages": [number]
  }
}

Rules:
1. Use only the provided context.
2. Read the full chat context before the poll and judge the custom option against it.
3. If the option clearly reuses, refines, or builds on one earlier idea, use reciprocity type "extension".
4. If the option mainly pushes back against a prior idea, use reciprocity type "contradiction".
5. If the option merges two or more earlier ideas into one, use reciprocity type "combination".
6. If it does not meaningfully connect to earlier ideas, use reciprocity type "unrelated".
7. For constructive classification:
   - "support" means it endorses a baseline option without adding a new condition
   - "opposition" means it rejects or votes against a baseline option without adding a new condition
   - "modification" means it proposes a concrete change, condition, or adjustment to the baseline option
   - "mitigation" means it softens, narrows, or makes the baseline option safer, cheaper, easier, or less risky
   - "neutral" means it does not clearly support, oppose, modify, or mitigate a baseline option
8. "referenced_messages" must contain the ids of the most relevant messages from the transcript when available.
9. "confidence" must be a number between 0 and 1.
10. If you are uncertain, prefer "neutral" for constructive and "unrelated" for reciprocity with lower confidence.
