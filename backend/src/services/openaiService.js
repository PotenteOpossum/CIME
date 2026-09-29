import { generateAgent1Reply, roomShouldAutoBot } from './agent1Service.js';

export { roomShouldAutoBot };

export async function maybeGenerateBotReply({ roomId, triggerText, allowDuringPoll = false }) {
  return generateAgent1Reply({ roomId, triggerText, allowDuringPoll });
}
