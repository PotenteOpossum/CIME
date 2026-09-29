import { createRouter } from '../middleware/router.js';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import { getDecisionStatus, logAgentEvent } from '../services/agent2Service.js';
import { clusteringPublicReason, getDecisionSettings, renderTemplate } from '../services/agentConfigService.js';
import { readLog } from '../services/decisionLogService.js';
import client from '../services/llm.js';

const router = createRouter();
const llm = client;

router.use(authMiddleware);

function publicDecisionStatus() {
  const status = getDecisionStatus();
  const settings = getDecisionSettings();
  return {
    global_question: status.global_question,
    general_description: status.general_description,
    current_phase: status.current_phase,
    process_started_at: status.process_started_at,
    phase1: status.phase1,
    clustering: {
      reason: clusteringPublicReason(settings.clustering_strategy)
    },
    agents: (status.agents || []).map((agent) => ({
      key: agent.key,
      name: agent.name,
      role: agent.role,
      doing: agent.doing,
      why: agent.why,
      events: (agent.events || []).map(publicAgentEvent).filter(Boolean).slice(0, 4)
    }))
  };
}

function publicAgentEvent(event) {
  const summaryMap = {
    'Started decision process': 'Started the decision process',
    'Opened personal chats': 'Opened personal information chats',
    'Closed personal chat': 'Completed a personal information check',
    'Opened Global Discussion': 'Opened the group discussion',
    'Started group discussion': 'Started guiding the group discussion',
    'Created mandatory poll': 'Created a poll',
    'Closed poll': 'Closed a poll',
    'Adjusted mediator prompt after split vote': 'Adjusted the group discussion strategy after a split vote',
    'Asked for Other explanations': 'Asked users to explain Other votes',
    'Awaiting related-point check': 'Checking whether related points remain before closing',
    'Reopened discussion for related points': 'Reopened discussion for related points',
    'Completed decision process': 'Completed the decision process',
    'Updated decision settings': 'Updated process settings',
    'Updated decision settings and personal prompts': 'Updated process settings',
    'Created discussion groups': 'Created discussion groups'
  };

  const summary = summaryMap[event.summary];
  if (!summary) return null;
  return {
    summary,
    created_at: event.created_at
  };
}

router.get('/', (_req, res) => {
  return res.json(publicDecisionStatus());
});

router.post('/agent-chat', async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  const status = publicDecisionStatus();
  logAgentEvent('agent2', 'User asked for process status', `${req.user.username}: ${message}`);

  const fallback =
    `Current phase: ${status.current_phase}. ` +
    (status.global_question ? `Question: ${status.global_question}. ` : '') +
    `Phase 1 progress: ${status.phase1?.completed || 0}/${status.phase1?.total || 0}. ` +
    'I can explain what is happening, but only the admin can change the process.';

  if (!llm) return res.json({ reply: fallback });

  const response = await llm.chat.completions.create({
    model: env.openaiModel,
    temperature: 0.2,
    max_completion_tokens: 260,
    messages: [
      {
        role: 'system',
        content: renderTemplate('admin-templates.md#User Agent Chat System')
      },
      {
        role: 'user',
        content: renderTemplate('admin-templates.md#User Agent Chat User', {
          status: JSON.stringify(status, null, 2),
          decision_log: JSON.stringify(readLog() || {}, null, 2),
          message
        })
      }
    ],
    metadata: { caller: 'user-agent-chat' }
  });

  return res.json({ reply: response.choices?.[0]?.message?.content?.trim() || fallback });
});

export default router;
