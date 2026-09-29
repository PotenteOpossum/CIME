// Population-level instructions for simulation persona autofill. The mode changes
// starting positions, not the OCEAN values or the later argument-responsive vote model.
export const PERSONA_AUTOFILL_MODES = Object.freeze({
  MIXED_PERSPECTIVES: 'mixed_perspectives',
  STRONG_DISAGREEMENT: 'strong_disagreement'
});

const LENSES = Object.freeze([
  {
    key: 'supportive',
    text: 'Focus on the benefits of the proposal and the conditions that would make it worthwhile, while acknowledging practical risks.'
  },
  {
    key: 'skeptical',
    text: 'Stress-test the proposal, identify unintended consequences, and ask what safeguards would be needed before supporting it.'
  },
  {
    key: 'cost_focused',
    text: 'Prioritize affordability, distributional effects, funding, and value for money. Ask who pays and who benefits.'
  },
  {
    key: 'accessibility_focused',
    text: 'Prioritize inclusion and accessibility for people with different abilities, incomes, ages, schedules, and practical constraints.'
  },
  {
    key: 'implementation_focused',
    text: 'Prioritize feasibility, sequencing, enforcement, governance, and how the proposal could work in practice.'
  }
]);

export function normalizePersonaAutofillMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return Object.values(PERSONA_AUTOFILL_MODES).includes(normalized)
    ? normalized
    : PERSONA_AUTOFILL_MODES.MIXED_PERSPECTIVES;
}

function boundedIndex(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function getTopicPattern(mode, assignmentIndex, topicCount) {
  const mixedPattern = ['moderate_support', 'moderate_opposition', 'conditional_support', 'conditional_opposition'];
  const strongPattern = ['strong_support', 'strong_opposition', 'conditional_support', 'conditional_opposition'];
  const pattern = mode === PERSONA_AUTOFILL_MODES.STRONG_DISAGREEMENT ? strongPattern : mixedPattern;
  return Array.from({ length: Math.max(0, boundedIndex(topicCount)) }, (_, topicIndex) => (
    pattern[(assignmentIndex + topicIndex) % pattern.length]
  ));
}

/**
 * Returns the deterministic population assignment used in the prompt. The LLM
 * writes the natural-language persona, while this plan makes the requested
 * balance explicit and testable.
 */
export function getPersonaAutofillPlan({ mode, assignmentIndex = 0, populationSize = 1, topicCount = 0 } = {}) {
  const normalizedMode = normalizePersonaAutofillMode(mode);
  const index = boundedIndex(assignmentIndex);
  const size = Math.max(1, boundedIndex(populationSize) || 1);
  const lens = LENSES[index % LENSES.length];

  if (normalizedMode === PERSONA_AUTOFILL_MODES.STRONG_DISAGREEMENT) {
    const stancePattern = ['strong_support', 'strong_opposition', 'conditional_support', 'conditional_opposition'][index % 4];
    return {
      mode: normalizedMode,
      assignmentIndex: index,
      populationSize: size,
      lens: lens.key,
      lensText: lens.text,
      stancePattern,
      topicPattern: getTopicPattern(normalizedMode, index, topicCount),
      intensityRange: stancePattern.startsWith('strong') ? [0.75, 1] : [0.45, 0.7],
      instruction: 'Create a visibly divided but respectful panel. Across the population, each topic should contain both support and opposition. Do not give one participant the same side on every topic: rotate the direction by topic so disagreement is topic-specific. Strong positions should remain reasoned and revisable, not insulting or irrational.'
    };
  }

  return {
    mode: normalizedMode,
    assignmentIndex: index,
    populationSize: size,
    lens: lens.key,
    lensText: lens.text,
    stancePattern: 'moderate_mixed',
    topicPattern: getTopicPattern(normalizedMode, index, topicCount),
    intensityRange: [0.35, 0.75],
    instruction: 'Create a varied panel with overlapping interests and different priorities. Across the population, include support, reservations, and conditional positions on every topic. Avoid making all participants agree or making disagreement depend on hostility.'
  };
}

export function buildPersonaAutofillPopulationInstructions(plan) {
  return [
    `Autofill mode: ${plan.mode}. This is participant ${plan.assignmentIndex + 1} of ${plan.populationSize}.`,
    `Assigned perspective lens: ${plan.lens}. ${plan.lensText}`,
    `Starting stance pattern: ${plan.stancePattern}. Suggested intensity range: ${plan.intensityRange[0]} to ${plan.intensityRange[1]}.`,
    plan.topicPattern?.length ? `For topics in their configured order, use these starting directions: ${plan.topicPattern.join(', ')}.` : '',
    plan.instruction,
    'Keep the starting stance distinct from the agent personality. Do not change OCEAN traits, invent unsupported biographical facts, or treat a starting stance as immutable. Participants may revise their view when later arguments are persuasive.'
  ].join(' ');
}
