import { useEffect, useMemo, useRef, useState } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { apiDownload, apiRequest } from '../api/client.js';
import { createQualityPolling } from '../utils/qualityPolling.js';

const Plot = createPlotlyComponent(Plotly);

export default function QualityTab({ token }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [hoveredChart, setHoveredChart] = useState(null); // { chartId, index }
  const [infoModal, setInfoModal] = useState(null);
  
  // Filter state
  const [selectedTopic, setSelectedTopic] = useState('');       // '' = all
  const [selectedRoomType, setSelectedRoomType] = useState(''); // '' = all

  // View state: 'timeSeries' | 'compareTopics' | 'compareRooms'
  const [viewMode, setViewMode] = useState('timeSeries');

  // Sankey states
  const [sankeyTopic, setSankeyTopic] = useState('');
  const [sankeyRoom, setSankeyRoom] = useState(''); // 'all' or room ID
  const [showDidNotVote, setShowDidNotVote] = useState(true);
  const [showFinalDecision, setShowFinalDecision] = useState(true);
  const [showPersonalPhase, setShowPersonalPhase] = useState(false);

  // Set defaults once when stats are first loaded
  useEffect(() => {
    if (stats?.sankeyData) {
      const topics = Object.keys(stats.sankeyData).sort();
      if (topics.length > 0) {
        setSankeyTopic(prev => {
          if (prev && stats.sankeyData[prev]) return prev;
          return selectedTopic && stats.sankeyData[selectedTopic] ? selectedTopic : topics[0];
        });
      }
    }
  }, [stats, selectedTopic]);

  // Set default room when topic changes
  useEffect(() => {
    if (stats?.sankeyData && sankeyTopic) {
      const rooms = Object.keys(stats.sankeyData[sankeyTopic]) || [];
      setSankeyRoom(prev => {
        if (prev === 'all') return 'all';
        if (prev && rooms.includes(prev)) return prev;
        return 'all'; // Default to "All Rooms"
      });
    }
  }, [sankeyTopic, stats]);

  useEffect(() => {
    if (!infoModal) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeInfoModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [infoModal]);

  const pollingRef = useRef(null);
  const fetchStats = (force = false) => pollingRef.current?.refresh(force);

  const downloadComputedRunData = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { blob, filename } = await apiDownload('/admin/decision-process/export', token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (downloadFailure) {
      setDownloadError(downloadFailure.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedTopic) params.set('topic', selectedTopic);
    if (selectedRoomType) params.set('room_type', selectedRoomType);
    const query = params.toString();
    const polling = createQualityPolling({
      request: (url, options) => apiRequest(url, options, token),
      statisticsUrl: '/admin/decision-process/statistics' + (query ? `?${query}` : ''),
      onData: setStats,
      onError: setError,
      onLoading: setLoading
    });
    pollingRef.current = polling;
    return () => {
      polling.dispose();
      if (pollingRef.current === polling) pollingRef.current = null;
    };
  }, [token, selectedTopic, selectedRoomType]);

  if (loading && !stats) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent"></div>
        <span className="ml-3 text-slate-400">Loading quality metrics...</span>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="rounded border border-red-800 bg-red-900/20 p-4 text-red-300">
        <h3 className="font-semibold">Error Loading Statistics</h3>
        <p className="text-sm mt-1">{error}</p>
        <button onClick={() => fetchStats(true)} className="mt-3 rounded bg-red-800 px-3 py-1.5 text-xs text-white hover:bg-red-700">Retry</button>
      </div>
    );
  }

  const summary = stats?.summary || {
    totalPolls: 0,
    totalRankingPolls: 0,
    totalResolvedPolls: 0,
    totalPassedPolls: 0,
    passedPollsRatio: 0,
    failedPolls: 0,
    failedPollsRatio: 0,
    tiePolls: 0,
    tiePollsRatio: 0,
    avgEntropy: 0,
    globalGiniCoefficient: 0,
    deliberativeQuality: {
      score: 0,
      messageCount: 0,
      dimensions: {
        participationEquality: 0,
        justification: 0,
        reciprocity: 0,
        respect: 0,
        constructiveness: 0,
        epistemicOrientation: 0
      },
      weights: {
        participationEquality: 0.18,
        justification: 0.18,
        reciprocity: 0.16,
        respect: 0.16,
        constructiveness: 0.17,
        epistemicOrientation: 0.15
      }
    },
    totalMessages: 0,
    avgWordsPerMessage: 0,
    totalBotMessages: 0,
    totalUsers: 0,
    topicsCount: 0,
    topicsPassedFirstTry: 0,
    firstTrySuccessRate: 0,
    avgVotesPerTopic: 0,
    avgPollsPerTopic: 0,
    totalSuggestions: 0,
    uniqueSuggestionsCount: 0,
    suggestionsWon: 0,
    newOptionsSuggested: {
      total: 0,
      analyzed: 0,
      extensionCount: 0,
      contradictionCount: 0,
      combinationCount: 0,
      unrelatedCount: 0,
      extensionRate: 0,
      contradictionRate: 0,
      combinationRate: 0,
      unrelatedRate: 0
    },
    proactiveness: {
      total: 0,
      supportCount: 0,
      oppositionCount: 0,
      modificationCount: 0,
      mitigationCount: 0,
      neutralCount: 0,
      supportRate: 0,
      oppositionRate: 0,
      modificationRate: 0,
      mitigationRate: 0,
      neutralRate: 0,
      rate: 0,
      propositiveUsersAnalyzed: 0,
      propositiveUsersCount: 0,
      propositiveUsersRate: 0
    },
    totalOptionSwitches: 0,
    totalSwitchOpportunities: 0,
    optionSwitchRate: 0,
    opinionMixingIndex: 0,
    opinionMixingCoverage: 0,
    opinionMixingComparableUsers: 0,
    opinionMixingComparablePairs: 0
  };

  const filters = stats?.filters || { availableTopics: [], availableRoomTypes: [] };
  const timeSeries = stats?.timeSeries || [];

  const toPercent = (val) => `${(val * 100).toFixed(1)}%`;
  const deliberativeQuality = summary.deliberativeQuality || {};
  const deliberativeDimensions = deliberativeQuality.dimensions || {};

  const metricInfo = {
    deliberativeQuality: {
      title: 'Deliberative Quality',
      description: 'This composite score estimates how deliberative the discussion was by combining participation equality with AQuA-inspired LLM judgments and embedding-based semantic signals for justification, reciprocity/listening, respect, constructiveness, and epistemic orientation.',
      notes: [
        'Computed on non-admin group and convergence-room messages, excluding personal rooms.',
        'Participation equality is structural. The other dimensions are now scored per message with an LLM rubric and enriched with embedding similarity signals such as topical relevance, responsiveness, and novelty.',
        'Weights: equality 18%, justification 18%, reciprocity 16%, respect 16%, constructiveness 17%, epistemic orientation 15%.',
        'Analyses are cached in SQLite so the first refresh may be slower, but later refreshes reuse stored evaluations.',
        'This is a process-quality measure, not a guarantee that the final decision is correct.'
      ]
    },
    consensusPassRate: {
      title: 'Consensus Pass Rate',
      description: 'This card shows the share of resolved polls that ended in agreement. It is a compact quality indicator for how often the discussion converged without needing to escalate to another round.',
      notes: [
        'Computed as total passed polls divided by total resolved polls.',
        'A "resolved" poll is one that closed or received a final consensus result.',
        'A higher value means the process is reaching agreement more often.'
      ]
    },
    topicsPassedFirstTry: {
      title: 'Topics Passed First Try',
      description: 'This card shows how often a topic reached consensus on the first poll round inside a room. It reflects whether the discussion was efficient enough to converge without repeated voting.',
      notes: [
        'Computed as topics with first poll consensus divided by total topics observed.',
        'Useful for spotting topics that are naturally easy to settle versus those that need several rounds.',
        'A higher value usually means the prompts and room composition are working well together.'
      ]
    },
    newOptionsSuggested: {
      title: 'New Options Suggested',
      description: 'This card counts custom options that users introduced by clicking Other and classifies each one with an LLM into one of four kinds: extension, contradiction, combination, or unrelated. It helps you see not just how many new options appeared, but also how they relate to the discussion that came before them.',
      notes: [
        'Each custom option is analyzed against the transcript before the poll and, when relevant, the previous poll options from the same topic.',
        'Extension means the option builds on a prior idea; contradiction means it rejects one; combination means it merges several ideas; unrelated means it does not connect meaningfully to earlier discussion.',
        'The four percentages shown in the card are percentages of all custom options analyzed.'
      ]
    },
    proactiveness: {
      title: 'Proactiveness Rate',
      description: 'This card shows how often human messages are proactive instead of only reactive. Every message is classified into support, opposition, modification, mitigation, or neutral, and the card reports the percentage distribution across those five labels together with the share of users who are more proactive than reactive.',
      notes: [
        'Support and opposition are counted as reactive positions.',
        'Modification and mitigation are counted as proactive positions.',
        'The overall rate is computed as (modification + mitigation) / (support + opposition + modification + mitigation).',
        'The user percentage below the rate shows how many participants have a personal proactive rate above 0.5.'
      ]
    },
    suggestedOptionsWon: {
      title: 'Suggested Options Won',
      description: 'This card counts how many polls were won by an option that came from users rather than from the default template. It highlights when the discussion produced genuinely new ideas that became the group outcome.',
      notes: [
        'A "suggested" winner includes custom user options and the fallback "Other" option when it clearly wins.',
        'A higher number means user-generated ideas are actually influencing the final outcome.',
        'This metric is especially useful when you want to measure bottom-up participation.'
      ]
    },
    botMessages: {
      title: 'Bot Messages',
      description: 'This card counts all assistant, facilitation, and system-style messages sent by the bot during the decision process. It gives a quick picture of how much intervention the system needed to keep the conversation moving.',
      notes: [
        'Higher values can mean more active facilitation, more polls, or more reminders.',
        'Use it together with engagement and consensus metrics to judge whether the bot is helping or over-driving the discussion.',
        'This is a volume metric, not a quality metric on its own.'
      ]
    },
    optionSwitches: {
      title: 'Option Switches',
      description: 'This card shows how often people changed their top choice between consecutive polls on the same topic. It is a practical measure of preference volatility and visible persuasion.',
      notes: [
        'The grey text is the switch rate, computed as switches divided by opportunities to switch.',
        'A higher value can mean people are deliberating seriously, changing their minds, or being exposed to new arguments.',
        'A lower value can mean stability, but not necessarily better quality by itself.'
      ]
    },
    opinionMixing: {
      title: 'Opinion Mixing Index',
      description: 'This card summarizes how much participants reshaped their positions between their first and their last vote on the same topic. It is a normalized Kendall-tau rank distance: 0 means the preference order stayed identical, 1 means it fully reversed.',
      notes: [
        'Each participant\u2019s first and last votes are compared only within the same topic, never across topics, because opinion change is only defined on the same issue (as in pre/post designs used in Deliberative Polling, Fishkin 2009).',
        'For ranking polls the full preference order is compared; for ordinary choice polls the chosen option versus the rest is used as a coarse two-level ranking.',
        'The index is (1 - Kendall-like tau) / 2 over comparable option pairs, weighted by the number of comparable pairs.',
        'Values closer to 0 mean stable positions; values closer to 1 mean strong preference reversal.',
        'The coverage percentage tells you how many voters had enough same-topic evidence (at least two votes on one topic) to be included.'
      ]
    },
    avgWordsPerMessage: {
      title: 'Average Words per Message',
      description: 'This card shows the average length of human messages. It is a simple proxy for how much detail people are giving in the discussion at that stage.',
      notes: [
        'Computed as total words divided by total human messages.',
        'Longer messages can mean more explanation, but also more uncertainty or negotiation.',
        'It is best interpreted alongside activity volume and consensus metrics.'
      ]
    },
    avgVotesPerTopic: {
      title: 'Average Votes per Topic',
      description: 'This card shows how many votes, on average, each topic received. It helps you understand how much voting activity was required before a topic reached a decision.',
      notes: [
        'Computed from the total number of votes divided by the number of topics observed.',
        'A higher value usually means the topic needed more rounds or had more participants.',
        'This is useful for spotting topics that are hard to settle.'
      ]
    },
    avgPollsPerTopic: {
      title: 'Average Polls per Topic',
      description: 'This card shows how many poll rounds were generated for each topic on average. It captures the amount of structured deliberation used to get to a result.',
      notes: [
        'Computed as total polls on topics divided by the number of topics observed.',
        'A higher value means the process needed more formal voting steps.',
        'Very high values can point to ambiguous prompts or difficult trade-offs.'
      ]
    }
  };

  const chartInfo = {
    passedRatio: {
      title: 'Poll Consensus Success Rate',
      description: 'This chart tracks how many polls closed with consensus in each one-minute window. It is a time-based view of how often deliberation is converging instead of stalling.',
      notes: [
        'The value shown in the chart is the fraction of resolved polls that passed in each time bin.',
        'A rise over time usually means the discussion is becoming easier to settle.',
        'It is useful for spotting when the group starts to stabilize.'
      ]
    },
    entropy: {
      title: 'Opinion Fragmentation',
      description: 'This chart shows the average normalized Shannon entropy of votes over time (Pielou\u2019s evenness). It measures how split or concentrated the expressed preferences are in each interval.',
      notes: [
        '0.0 means full consensus, while 1.0 means votes are spread perfectly evenly across all options.',
        'Entropy is normalized by log2(number of options), so polls with different option counts are comparable (Shannon 1948; Pielou 1966).',
        'For ranking polls, entropy is computed on the distribution of first choices (rank 1), not on Borda scores, so the measure has the same meaning for every poll type.',
        'Swipe polls use the distribution of right-swipe approvals.',
        'A falling line indicates the group is converging.'
      ]
    },
    gini: {
      title: 'Participation Inequality',
      description: 'This chart tracks the Gini coefficient of message participation over time. It shows whether the conversation is shared evenly or dominated by a few users.',
      notes: [
        'Lower values mean a more balanced contribution pattern; higher values mean a few users dominate.',
        'The Gini coefficient is the standard inequality measure used for participation equality in deliberation research (cf. the Discourse Quality Index tradition, Steenbergen et al. 2003).',
        'The time-series view is computed over all registered participants; the per-room and per-topic comparisons are computed only over the users who actually belonged to that room or topic, so small rooms are not penalized by users who were never there.',
        'This is about participation fairness, not opinion diversity.'
      ]
    },
    activity: {
      title: 'Message Activity Volume',
      description: 'This chart counts human messages per minute. It helps you see when the conversation is active, quiet, or spiking because of a poll or bot intervention.',
      notes: [
        'It is a raw activity measure, not a quality metric by itself.',
        'Useful for spotting bursts of discussion after questions or poll prompts.',
        'Low activity can mean reflection, inactivity, or a stalled room.'
      ]
    },
    botMessages: {
      title: 'Bot Messages Over Time',
      description: 'This chart tracks how many bot-generated messages were sent in each minute. It captures facilitation intensity, automated prompts, and system-driven interventions.',
      notes: [
        'A high line can mean the system is intervening often.',
        'A lower line can mean the conversation is moving more on its own.',
        'Compare it with consensus and activity to understand whether the bot is helping or overused.'
      ]
    },
    deliberativeQuality: {
      title: 'Deliberative Quality Over Time',
      description: 'This chart tracks the composite deliberative-quality score in each one-minute interval. It shows when the conversation becomes more equal, reasoned, reciprocal, respectful, constructive, and evidence-oriented.',
      notes: [
        'The score is normalized from 0 to 1.',
        'A rising line usually means the conversation is becoming more deliberative, not simply more active.',
        'Interpret short empty intervals carefully because no messages means no measurable deliberation.'
      ]
    },
    optionSwitch: {
      title: 'Option Switch Rate',
      description: 'This chart measures how often users change their top choice between consecutive polls on the same topic. It is a time-based view of preference volatility and persuasion.',
      notes: [
        'The chart uses switches divided by switch opportunities in each minute.',
        'A high spike usually means the discussion is actively reshaping preferences.',
        'A flat line near zero can mean stable opinions or insufficient follow-up polls.'
      ]
    },
    avgWords: {
      title: 'Average Words per Message',
      description: 'This chart tracks the average length of human messages over time. It helps you see when users become more detailed, more concise, or more hesitant.',
      notes: [
        'Computed from human message word counts in each time bin.',
        'Useful for spotting more thoughtful, elaborate rounds of deliberation.',
        'Very long messages do not always mean better quality, but they do show more expression.'
      ]
    },
    compareConsensus: {
      title: 'Consensus Pass Rate Comparison',
      description: 'This comparison shows which topics or rooms reach consensus more often. It is the easiest high-level way to compare convergence performance across contexts.',
      notes: [
        'The bars show the share of resolved polls that passed.',
        'Higher values indicate smoother decision-making.',
        'Lower values suggest more friction, disagreement, or unresolved rounds.'
      ]
    },
    compareEntropy: {
      title: 'Opinion Fragmentation Comparison',
      description: 'This comparison shows the average normalized Shannon entropy of votes across topics or rooms. It tells you where opinions stay diverse for longer and where they converge more quickly.',
      notes: [
        'Use it to compare how polarized different deliberation contexts are.',
        'A lower bar indicates more agreement; a higher bar indicates more evenly split opinions.',
        'Ranking polls contribute the entropy of their first-choice distribution so all poll types are on the same 0\u20131 scale.'
      ]
    },
    compareGini: {
      title: 'Participation Inequality Comparison',
      description: 'This comparison shows which topics or rooms are more balanced in terms of who speaks. It is a fairness metric for participation, not for agreement.',
      notes: [
        'Lower bars mean participation is shared more evenly.',
        'Higher bars mean a few users dominate the conversation.',
        'The coefficient is computed only over the participants of that room or topic (members plus contributors), so rooms of different sizes are directly comparable.',
        'This can help identify rooms that need more facilitation.'
      ]
    },
    compareMessages: {
      title: 'Human Message Activity Comparison',
      description: 'This comparison shows the total amount of human participation by topic or room. It helps you compare which discussions were more active and which were quieter.',
      notes: [
        'It measures volume, not sentiment or quality.',
        'Useful for understanding engagement levels across decisions.',
        'High activity can be good, but it can also reflect confusion or unresolved disagreement.'
      ]
    },
    compareDeliberativeQuality: {
      title: 'Deliberative Quality Comparison',
      description: 'This comparison shows which topics or rooms had stronger deliberative process quality. It combines equality, reasoning, listening, respect, constructiveness, and evidence orientation.',
      notes: [
        'Higher bars mean stronger overall deliberative process quality.',
        'Use this with the message count chart: a quiet topic can score low because there is little observable deliberation.',
        'The metric is transparent and heuristic; it should guide review, not replace qualitative judgment.'
      ]
    },
    compareBot: {
      title: 'Bot Facilitation Messages Comparison',
      description: 'This comparison shows how much bot facilitation each topic or room required. It gives you a sense of where the system was more hands-on.',
      notes: [
        'More bot messages usually means more prompts, polls, or guardrail responses.',
        'Use this together with consensus metrics to judge efficiency.',
        'High facilitation is not automatically bad, but it is a signal worth investigating.'
      ]
    },
    compareSwitches: {
      title: 'Option Switch Rate Comparison',
      description: 'This comparison shows how often people changed their top choice across topics. It is a volatility metric for multi-round deliberation.',
      notes: [
        'Higher values imply stronger changes in stance between rounds.',
        'Lower values can mean stable preferences or little follow-up interaction.',
        'Only meaningful where consecutive polls exist on the same topic.'
      ]
    },
    compareMixing: {
      title: 'Opinion Mixing Index Comparison',
      description: 'This comparison shows how much opinion reshuffling happened across topics or rooms, measured as normalized Kendall-tau distance between each participant\u2019s first and last vote on the same topic.',
      notes: [
        'Values closer to 1 mean stronger movement in positions.',
        'Values closer to 0 mean the group stayed near its starting stance.',
        'First and last votes are always compared within the same topic, so option sets are identical and the comparison is meaningful.',
        'Coverage tells you how many voters had enough same-topic evidence to be included.'
      ]
    },
    compareWords: {
      title: 'Average Words per Message Comparison',
      description: 'This comparison shows where people wrote more or less verbosely. It is a simple but useful proxy for deliberation style.',
      notes: [
        'Longer messages can indicate explanation, negotiation, or uncertainty.',
        'Short messages can indicate quick agreement or low engagement.',
        'Interpret it together with activity and consensus.'
      ]
    },
    compareSuggestions: {
      title: 'Custom Options Suggested',
      description: 'This comparison shows where participants proposed the most custom alternatives. It is a good indicator of creativity and willingness to shape the choice space.',
      notes: [
        'Counts the number of custom suggestions made in polls.',
        'Higher values mean users are actively expanding the option set.',
        'Very low values can mean the predefined choices were sufficient or too restrictive.'
      ]
    },
    sankey: {
      title: 'Opinion Flow (Sankey Diagram)',
      description: 'This plot shows how people moved between options from one poll to the next. It is useful for seeing transition paths, persistence, and where people changed sides.',
      notes: [
        'Each band represents a flow from one option to another across successive rounds.',
        'The plot can include personal, group, and final phases depending on the selected toggles.',
        'The wider a band is, the more participants followed that transition.'
      ]
    }
  };

  const openInfoModal = (title, description, notes = []) => {
    setInfoModal({
      title,
      description,
      notes
    });
  };

  const closeInfoModal = () => setInfoModal(null);

  const InfoButton = ({ onClick, label = 'More info' }) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-[10px] font-bold text-slate-300 transition-colors hover:border-blue-500 hover:text-blue-200 hover:bg-blue-500/10"
    >
      i
    </button>
  );

  const InfoModal = () => {
    if (!infoModal) return null;

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-6 backdrop-blur-sm"
        onClick={closeInfoModal}
        role="presentation"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="quality-info-modal-title"
          className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-950 p-6 shadow-2xl shadow-black/40"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="quality-info-modal-title" className="text-lg font-semibold text-slate-100">
                {infoModal.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                {infoModal.description}
              </p>
            </div>
            <button
              type="button"
              onClick={closeInfoModal}
              className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              Close
            </button>
          </div>
          {infoModal.notes?.length > 0 && (
            <div className="mt-5 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">How it is computed or interpreted</h3>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
                {infoModal.notes.map((note, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400"></span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  };

  const MetricCard = ({ title, value, detail, accentClass = 'border-slate-800 bg-slate-900/40', valueClass = 'text-slate-100', detailClass = 'text-slate-500', onInfo, spanClass = '', children }) => (
    <div className={`rounded-xl border p-5 min-h-[132px] flex flex-col justify-between ${accentClass} ${spanClass}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-semibold text-slate-400 block leading-tight break-words">{title}</span>
        {onInfo && <InfoButton onClick={onInfo} label={`More info about ${title}`} />}
      </div>
      <div className="flex flex-col gap-2">
        <span className={`text-2xl font-bold leading-none ${valueClass}`}>{value}</span>
        <span className={`block text-xs font-medium leading-snug break-words whitespace-normal ${detailClass}`}>{detail}</span>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );

  // Custom SVG Area Chart Component (for Time-Series)
  const RenderSvgChart = ({ id, title, description, yKey, colorClass, strokeColor, fillColor, gradientId, maxValueOverride, isRatio, onInfo }) => {
    if (timeSeries.length === 0) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-100 text-sm">{title}</h3>
            {onInfo && <InfoButton onClick={onInfo} label={`More info about ${title}`} />}
          </div>
          <div className="flex h-48 items-center justify-center rounded border border-slate-800 bg-slate-900/40 text-slate-500 text-sm">
            No time-series data available yet.
          </div>
          <p className="mt-3 text-xs text-slate-400 leading-relaxed border-t border-slate-800/60 pt-2">{description}</p>
        </div>
      );
    }

    const svgWidth = 500;
    const svgHeight = 200;
    const paddingLeft = 45;
    const paddingRight = 15;
    const paddingTop = 20;
    const paddingBottom = 30;

    const graphWidth = svgWidth - paddingLeft - paddingRight;
    const graphHeight = svgHeight - paddingTop - paddingBottom;

    const values = timeSeries.map(d => d[yKey] || 0);
    const maxVal = maxValueOverride !== undefined ? maxValueOverride : Math.max(...values, 0.1);

    // Compute coordinate points
    const points = timeSeries.map((d, index) => {
      const val = d[yKey] || 0;
      const x = paddingLeft + (timeSeries.length > 1 ? (index / (timeSeries.length - 1)) * graphWidth : graphWidth / 2);
      const y = svgHeight - paddingBottom - (val / maxVal) * graphHeight;
      return { x, y, val, label: d.label };
    });

    // Generate Path descriptions
    let linePath = '';
    let areaPath = '';

    if (points.length > 0) {
      linePath = `M ${points[0].x} ${points[0].y} ` + points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ');
      areaPath = `${linePath} L ${points[points.length - 1].x} ${svgHeight - paddingBottom} L ${points[0].x} ${svgHeight - paddingBottom} Z`;
    }

    // Grid lines Y coordinates
    const yGridTicks = [0, 0.5, 1].map(ratio => {
      const val = ratio * maxVal;
      const y = svgHeight - paddingBottom - ratio * graphHeight;
      return { y, label: isRatio ? toPercent(ratio * maxVal) : val.toFixed(1) };
    });

    const hovered = hoveredChart?.chartId === id ? points[hoveredChart.index] : null;

    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-slate-100 text-sm">{title}</h3>
          <div className="flex items-center gap-2">
            {onInfo && <InfoButton onClick={onInfo} label={`More info about ${title}`} />}
            {hovered && (
              <div className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                {hovered.label} — <span className={colorClass}>{isRatio ? toPercent(hovered.val) : hovered.val.toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="relative">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-auto overflow-visible"
            onMouseLeave={() => setHoveredChart(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={fillColor} stopOpacity="0.35" />
                <stop offset="100%" stopColor={fillColor} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Grid Lines */}
            {yGridTicks.map((tick, i) => (
              <g key={i}>
                <line
                  x1={paddingLeft}
                  y1={tick.y}
                  x2={svgWidth - paddingRight}
                  y2={tick.y}
                  stroke="#334155"
                  strokeWidth="0.5"
                  strokeDasharray="4 4"
                />
                <text
                  x={paddingLeft - 8}
                  y={tick.y + 4}
                  textAnchor="end"
                  className="fill-slate-500 font-mono text-[9px]"
                >
                  {tick.label}
                </text>
              </g>
            ))}

            {/* Chart Area and Line */}
            {points.length > 0 && (
              <>
                <path d={areaPath} fill={`url(#${gradientId})`} />
                <path d={linePath} fill="none" stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}

            {/* Interaction Areas / Dots */}
            {points.map((p, index) => {
              const isHovered = hoveredChart?.chartId === id && hoveredChart?.index === index;
              return (
                <g key={index}>
                  {/* Invisible broad hover bar */}
                  <rect
                    x={p.x - graphWidth / (2 * Math.max(1, timeSeries.length - 1))}
                    y={paddingTop}
                    width={graphWidth / Math.max(1, timeSeries.length - 1)}
                    height={graphHeight + paddingBottom}
                    fill="transparent"
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredChart({ chartId: id, index })}
                  />
                  {/* Highlight point on hover */}
                  {isHovered && (
                    <>
                      <line
                        x1={p.x}
                        y1={paddingTop}
                        x2={p.x}
                        y2={svgHeight - paddingBottom}
                        stroke="#475569"
                        strokeWidth="1"
                        strokeDasharray="2 2"
                      />
                      <circle cx={p.x} cy={p.y} r="5" fill={strokeColor} stroke="#ffffff" strokeWidth="1.5" />
                    </>
                  )}
                </g>
              );
            })}

            {/* X Axis Labels */}
            {points.length > 0 && [0, Math.floor(points.length / 2), points.length - 1].map((idx) => {
              const p = points[idx];
              if (!p) return null;
              return (
                <text
                  key={idx}
                  x={p.x}
                  y={svgHeight - 10}
                  textAnchor={idx === 0 ? 'start' : idx === points.length - 1 ? 'end' : 'middle'}
                  className="fill-slate-500 font-mono text-[9px]"
                >
                  {p.label}
                </text>
              );
            })}
          </svg>
        </div>
        <p className="mt-3 text-xs text-slate-400 leading-relaxed border-t border-slate-800/60 pt-2">{description}</p>
      </div>
    );
  };

  // Custom SVG Bar Chart Component (for Topic/Room Comparisons)
  const RenderCompareChart = ({ id, title, description, yKey, colorClass, strokeColor, fillColor, isRatio, data, categoryKey, onInfo }) => {
    if (!data || data.length === 0) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-100 text-sm">{title}</h3>
            {onInfo && <InfoButton onClick={onInfo} label={`More info about ${title}`} />}
          </div>
          <div className="flex h-48 items-center justify-center rounded border border-slate-800 bg-slate-900/40 text-slate-500 text-sm">
            No comparison data available.
          </div>
          <p className="mt-3 text-xs text-slate-400 leading-relaxed border-t border-slate-800/60 pt-2">{description}</p>
        </div>
      );
    }

    // Special case for Option Switches on Rooms comparison
    if (categoryKey === 'roomId' && (yKey === 'optionSwitchRate' || yKey === 'optionSwitches')) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md flex flex-col justify-between h-full min-h-[250px]">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold text-slate-100 text-sm mb-2">{title}</h3>
            {onInfo && <InfoButton onClick={onInfo} label={`More info about ${title}`} />}
          </div>
          <div>
            <p className="text-xs text-slate-400 leading-relaxed border-t border-slate-800/60 pt-2">{description}</p>
          </div>
          <div className="flex flex-col items-center justify-center flex-grow border border-dashed border-slate-800 rounded-lg p-4 bg-slate-950/20 text-center">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-8 h-8 text-slate-600 mb-2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
            </svg>
            <span className="text-xs text-slate-500 font-medium">Not Applicable for Rooms</span>
            <p className="text-[10px] text-slate-600 mt-1 max-w-[200px]">Option switches occur when users change their votes between rounds on a specific topic. This comparison makes sense only across topics.</p>
          </div>
        </div>
      );
    }

    const svgWidth = 500;
    const svgHeight = 200;
    const paddingLeft = 45;
    const paddingRight = 15;
    const paddingTop = 20;
    const paddingBottom = 40;

    const graphWidth = svgWidth - paddingLeft - paddingRight;
    const graphHeight = svgHeight - paddingTop - paddingBottom;

    const values = data.map(d => d[yKey] || 0);
    const maxVal = isRatio ? 1.0 : Math.max(...values, 0.1);

    const M = data.length;
    const slotWidth = graphWidth / M;
    const barWidth = Math.min(32, slotWidth * 0.55);

    const hovered = hoveredChart?.chartId === id ? data[hoveredChart.index] : null;

    // Grid lines Y coordinates
    const yGridTicks = [0, 0.5, 1].map(ratio => {
      const val = ratio * maxVal;
      const y = svgHeight - paddingBottom - ratio * graphHeight;
      return { y, label: isRatio ? toPercent(ratio * maxVal) : val.toFixed(1) };
    });

    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-slate-100 text-sm">{title}</h3>
          <div className="flex items-center gap-2">
            {onInfo && <InfoButton onClick={onInfo} label={`More info about ${title}`} />}
            {hovered && (
              <div className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded max-w-[250px] truncate">
                {hovered.topic || hovered.roomName} — <span className={colorClass}>{isRatio ? toPercent(hovered[yKey]) : hovered[yKey].toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="relative">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-auto overflow-visible"
            onMouseLeave={() => setHoveredChart(null)}
          >
            {/* Grid Lines */}
            {yGridTicks.map((tick, i) => (
              <g key={i}>
                <line
                  x1={paddingLeft}
                  y1={tick.y}
                  x2={svgWidth - paddingRight}
                  y2={tick.y}
                  stroke="#334155"
                  strokeWidth="0.5"
                  strokeDasharray="4 4"
                />
                <text
                  x={paddingLeft - 8}
                  y={tick.y + 4}
                  textAnchor="end"
                  className="fill-slate-500 font-mono text-[9px]"
                >
                  {tick.label}
                </text>
              </g>
            ))}

            {/* Bars */}
            {data.map((d, index) => {
              const val = d[yKey] || 0;
              const barHeight = (val / maxVal) * graphHeight;
              const x = paddingLeft + index * slotWidth + (slotWidth - barWidth) / 2;
              const y = svgHeight - paddingBottom - barHeight;

              const isHovered = hoveredChart?.chartId === id && hoveredChart?.index === index;
              const labelText = d.topic || d.roomName || '';
              const shortLabel = labelText.length > 10 ? labelText.substring(0, 8) + '..' : labelText;

              return (
                <g key={index}>
                  {/* Actual Visual Bar */}
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(2, barHeight)}
                    fill={fillColor}
                    opacity={isHovered ? 0.95 : 0.65}
                    stroke={isHovered ? '#ffffff' : 'none'}
                    strokeWidth="1"
                    rx="3"
                    className="transition-all duration-150"
                  />
                  
                  {/* Category label */}
                  <text
                    x={paddingLeft + index * slotWidth + slotWidth / 2}
                    y={svgHeight - 12}
                    textAnchor="middle"
                    className={`font-sans text-[8px] transition-colors ${isHovered ? 'fill-slate-200 font-semibold' : 'fill-slate-500'}`}
                  >
                    {shortLabel}
                  </text>

                  {/* Invisible hover area */}
                  <rect
                    x={paddingLeft + index * slotWidth}
                    y={paddingTop}
                    width={slotWidth}
                    height={graphHeight + paddingBottom}
                    fill="transparent"
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredChart({ chartId: id, index })}
                  />
                </g>
              );
            })}
          </svg>
        </div>
        <p className="mt-3 text-xs text-slate-400 leading-relaxed border-t border-slate-800/60 pt-2">{description}</p>
      </div>
    );
  };

  // Custom SVG Sankey opinion flow diagram component
  const RenderSankeyPlot = ({ onInfo }) => {
    const containerRef = useRef(null);
    const [hoveredLink, setHoveredLink] = useState(null); // { source, target, value, usernames, x, y }
    const [hoveredNode, setHoveredNode] = useState(null); // nodeId

    const sankeyData = stats?.sankeyData || {};
    const availableSankeyTopics = Object.keys(sankeyData).sort();
    const availableSankeyRooms = sankeyTopic && sankeyData[sankeyTopic]
      ? Object.keys(sankeyData[sankeyTopic])
          .filter(roomId => {
            const name = sankeyData[sankeyTopic][roomId]?.roomName || '';
            return !name.toLowerCase().includes('personal');
          })
          .sort()
      : [];

    let roomData = null;

    if (sankeyTopic && sankeyData[sankeyTopic]) {
      if (sankeyRoom === 'all') {
        const roomsData = Object.values(sankeyData[sankeyTopic]);
        if (roomsData.length > 0) {
          // Helper to check if room is convergence phase
          const isConvergence = (r) => r.roomType === 'convergence' || r.roomName.toLowerCase().includes('convergence');
          
          const groupRooms = roomsData.filter(r => !isConvergence(r));
          const convergenceRooms = roomsData.filter(r => isConvergence(r));

          // Find max deliberation polls in each phase (excluding personal and final)
          const maxGroupPollsCount = groupRooms.length > 0
            ? Math.max(...groupRooms.map(r => r.polls.filter(p => !p.isPersonalPhase && !p.isFinalDecision).length))
            : 0;

          const maxConvergencePollsCount = convergenceRooms.length > 0
            ? Math.max(...convergenceRooms.map(r => r.polls.filter(p => !p.isPersonalPhase && !p.isFinalDecision).length))
            : 0;

          const mergedPolls = [];

          // 1. Personal Phase
          let hasPersonal = false;
          roomsData.forEach(r => {
            if (r.polls.some(p => p.isPersonalPhase)) hasPersonal = true;
          });
          if (hasPersonal) {
            mergedPolls.push({
              id: 'merged_personal',
              question: 'Initial preferences from personal rooms',
              suggestion: sankeyTopic,
              isPersonalPhase: true
            });
          }

          // 2. Group Phase Deliberation Rounds
          for (let i = 0; i < maxGroupPollsCount; i++) {
            const questions = [];
            groupRooms.forEach(r => {
              const groupPolls = r.polls.filter(p => !p.isPersonalPhase && !p.isFinalDecision);
              const p = groupPolls[i];
              if (p) {
                questions.push(`[${r.roomName}] ${p.question}`);
              }
            });
            mergedPolls.push({
              id: `merged_group_${i}`,
              question: questions.join('\n'),
              suggestion: sankeyTopic,
              isGroupPhase: true
            });
          }

          // 3. Convergence Phase Deliberation Rounds
          for (let i = 0; i < maxConvergencePollsCount; i++) {
            const questions = [];
            convergenceRooms.forEach(r => {
              const convPolls = r.polls.filter(p => !p.isPersonalPhase && !p.isFinalDecision);
              const p = convPolls[i];
              if (p) {
                questions.push(`[${r.roomName}] ${p.question}`);
              }
            });
            mergedPolls.push({
              id: `merged_convergence_${i}`,
              question: questions.join('\n'),
              suggestion: sankeyTopic,
              isConvergencePhase: true
            });
          }

          // 4. Final Decision
          let finalDecisionPollRef = null;
          let finalDecisionQuestions = [];
          // Search convergence rooms first
          convergenceRooms.forEach(r => {
            const fp = r.polls.find(p => p.isFinalDecision);
            if (fp) {
              finalDecisionPollRef = fp;
              finalDecisionQuestions.push(`[${r.roomName}] ${fp.question}`);
            }
          });
          // Fallback to group rooms if no convergence final poll found yet
          if (!finalDecisionPollRef) {
            groupRooms.forEach(r => {
              const fp = r.polls.find(p => p.isFinalDecision);
              if (fp) {
                finalDecisionPollRef = fp;
                finalDecisionQuestions.push(`[${r.roomName}] ${fp.question}`);
              }
            });
          }
          if (finalDecisionPollRef) {
            mergedPolls.push({
              id: 'merged_final_decision',
              question: finalDecisionQuestions.join('\n'),
              suggestion: sankeyTopic,
              isFinalDecision: true
            });
          }

          // Combine votes by physical user ID (avoiding duplicate nodes for same user)
          const mergedUserVotes = {};
          const getOrCreateUser = (userId, username) => {
            if (!mergedUserVotes[userId]) {
              mergedUserVotes[userId] = {
                username: username,
                personalVote: null,
                groupVotes: [],       // list of { poll, optText }
                convergenceVotes: [], // list of { poll, optText }
                finalVote: null
              };
            }
            return mergedUserVotes[userId];
          };

          roomsData.forEach(r => {
            const isConv = isConvergence(r);
            Object.entries(r.userVotes).forEach(([userId, userVoteObj]) => {
              const user = getOrCreateUser(userId, userVoteObj.username);
              r.polls.forEach((poll, pollIdx) => {
                const vote = userVoteObj.votes[pollIdx];
                const optText = vote ? vote.optionText : 'Did Not Vote';
                if (poll.isPersonalPhase) {
                  user.personalVote = optText;
                } else if (poll.isFinalDecision) {
                  if (isConv || !user.finalVote) {
                    user.finalVote = optText;
                  }
                } else {
                  if (isConv) {
                    user.convergenceVotes.push({ poll, optText });
                  } else {
                    user.groupVotes.push({ poll, optText });
                  }
                }
              });
            });
          });

          // Align votes arrays 1-to-1 with mergedPolls
          const finalUserVotes = {};
          Object.entries(mergedUserVotes).forEach(([userId, user]) => {
            const alignedVotes = [];

            // 1. Personal Phase
            if (hasPersonal) {
              alignedVotes.push({
                pollId: 'merged_personal',
                optionText: user.personalVote || 'Did Not Vote'
              });
            }

            // 2. Group Phase
            for (let i = 0; i < maxGroupPollsCount; i++) {
              const v = user.groupVotes[i];
              alignedVotes.push({
                pollId: `merged_group_${i}`,
                optionText: v ? v.optText : 'Did Not Vote'
              });
            }

            // 3. Convergence Phase
            for (let i = 0; i < maxConvergencePollsCount; i++) {
              const v = user.convergenceVotes[i];
              alignedVotes.push({
                pollId: `merged_convergence_${i}`,
                optionText: v ? v.optText : 'Did Not Vote'
              });
            }

            // 4. Final Decision
            if (finalDecisionPollRef) {
              alignedVotes.push({
                pollId: 'merged_final_decision',
                optionText: user.finalVote || 'Did Not Vote'
              });
            }

            finalUserVotes[userId] = {
              username: user.username,
              votes: alignedVotes
            };
          });

          roomData = {
            roomId: 'all',
            roomName: 'All Rooms',
            polls: mergedPolls,
            userVotes: finalUserVotes
          };
        }
      } else if (sankeyData[sankeyTopic][sankeyRoom]) {
        roomData = sankeyData[sankeyTopic][sankeyRoom];
      }
    }

    if (!roomData || !roomData.polls || roomData.polls.length === 0) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-200">Opinion Flow (Sankey Diagram)</h3>
            {onInfo && <InfoButton onClick={onInfo} label="More info about Opinion Flow (Sankey Diagram)" />}
          </div>
          <p className="text-xs text-slate-400 mb-4">Select a topic and a room to track user vote flows from the beginning to the end of the deliberation.</p>
          <div className="flex h-48 flex-col items-center justify-center border border-dashed border-slate-800 rounded-lg bg-slate-950/20 text-slate-500 text-sm">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-8 h-8 mb-2 text-slate-600">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 5.25h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5" />
            </svg>
            No vote flow data available for the selected topic and room.
          </div>
        </div>
      );
    }

    let polls = roomData.polls || [];
    let users = Object.values(roomData.userVotes || {});

    // Filter out personal phase polls if setting is disabled
    if (!showPersonalPhase) {
      const personalIndices = new Set();
      polls.forEach((p, idx) => {
        if (p.isPersonalPhase) personalIndices.add(idx);
      });

      if (personalIndices.size > 0) {
        polls = polls.filter((_, idx) => !personalIndices.has(idx));
        users = users.map(u => ({
          ...u,
          votes: (u.votes || []).filter((_, idx) => !personalIndices.has(idx))
        }));
      }
    }

    // Filter out final decision polls if setting is disabled
    if (!showFinalDecision) {
      const finalIndices = new Set();
      polls.forEach((p, idx) => {
        if (p.isFinalDecision) finalIndices.add(idx);
      });

      if (finalIndices.size > 0) {
        polls = polls.filter((_, idx) => !finalIndices.has(idx));
        users = users.map(u => ({
          ...u,
          votes: (u.votes || []).filter((_, idx) => !finalIndices.has(idx))
        }));
      }
    }

    if (polls.length === 0) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 relative" ref={containerRef}>
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Opinion Flow (Sankey Diagram)</h3>
              <p className="text-xs text-slate-400 mt-1">Track voter transitions and consensus build-up from poll to poll.</p>
            </div>
            
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500">Topic:</label>
                  <select
                    value={sankeyTopic}
                    onChange={(e) => setSankeyTopic(e.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
                  >
                    {availableSankeyTopics.map(topic => (
                      <option key={topic} value={topic}>{topic}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500">Room:</label>
                  <select
                    value={sankeyRoom}
                    onChange={(e) => setSankeyRoom(e.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="all">All Rooms (Combined)</option>
                    {availableSankeyRooms.map(roomId => (
                      <option key={roomId} value={roomId}>{sankeyData[sankeyTopic]?.[roomId]?.roomName || roomId}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none hover:text-slate-200 transition-colors">
                  <input
                    type="checkbox"
                    checked={showDidNotVote}
                    onChange={(e) => setShowDidNotVote(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                  />
                  Show "Did Not Vote"
                </label>

                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none hover:text-slate-200 transition-colors">
                  <input
                    type="checkbox"
                    checked={showPersonalPhase}
                    onChange={(e) => setShowPersonalPhase(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                  />
                  Include Personal Rooms
                </label>

                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none hover:text-slate-200 transition-colors">
                  <input
                    type="checkbox"
                    checked={showFinalDecision}
                    onChange={(e) => setShowFinalDecision(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                  />
                  Show Final Decision
                </label>
              </div>
            </div>
          </div>
          <div className="flex h-48 flex-col items-center justify-center border border-dashed border-slate-800 rounded-lg bg-slate-950/20 text-slate-500 text-sm">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-8 h-8 mb-2 text-slate-600">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 5.25h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5" />
            </svg>
            No polls to show based on selected settings.
          </div>
        </div>
      );
    }

    const N = users.length;

    // Identify nodes for each column
    const columns = polls.map((poll, colIdx) => {
      const optionCounts = {};
      for (const u of users) {
        const vote = u.votes[colIdx];
        const optText = vote ? vote.optionText : 'Did Not Vote';
        if (!showDidNotVote && optText === 'Did Not Vote') continue;
        optionCounts[optText] = (optionCounts[optText] || 0) + 1;
      }

      const sortedOptions = Object.keys(optionCounts).sort((a, b) => {
        if (a === 'Did Not Vote') return 1;
        if (b === 'Did Not Vote') return -1;
        return optionCounts[b] - optionCounts[a];
      });

      return sortedOptions.map(opt => ({
        optionText: opt,
        votesCount: optionCounts[opt],
        id: `col_${colIdx}::${opt}`
      }));
    });

    // Identify links between adjacent columns
    const links = [];
    for (let colIdx = 0; colIdx < columns.length - 1; colIdx++) {
      const transitionCounts = {};
      for (const u of users) {
        const srcOpt = u.votes[colIdx]?.optionText || 'Did Not Vote';
        const tgtOpt = u.votes[colIdx + 1]?.optionText || 'Did Not Vote';
        if (!showDidNotVote && (srcOpt === 'Did Not Vote' || tgtOpt === 'Did Not Vote')) continue;
        const key = `${srcOpt} ===> ${tgtOpt}`;
        if (!transitionCounts[key]) {
          transitionCounts[key] = { count: 0, usernames: [] };
        }
        transitionCounts[key].count++;
        transitionCounts[key].usernames.push(u.username);
      }

      for (const key in transitionCounts) {
        const [srcOpt, tgtOpt] = key.split(' ===> ');
        const { count, usernames } = transitionCounts[key];
        if (count > 0) {
          links.push({
            source: `col_${colIdx}::${srcOpt}`,
            target: `col_${colIdx + 1}::${tgtOpt}`,
            value: count,
            usernames,
            colIndex: colIdx
          });
        }
      }
    }

    const width = 800;
    const height = 450;
    const paddingTop = 60;
    const paddingBottom = 40;
    const paddingLeft = 40;
    const paddingRight = 40;

    const graphWidth = width - paddingLeft - paddingRight;
    const graphHeight = height - paddingTop - paddingBottom;
    const dx = columns.length > 1 ? graphWidth / (columns.length - 1) : graphWidth;
    const nodeWidth = 18;
    const nodeGap = 16;

    const maxNodes = Math.max(...columns.map(c => c.length), 1);
    const scaleY = N > 0 ? (graphHeight - (maxNodes - 1) * nodeGap) / N : 0;

    const nodeMap = {};
    columns.forEach((colNodes, colIdx) => {
      const x = paddingLeft + colIdx * dx;
      const totalColHeight = colNodes.length > 0 ? colNodes.reduce((sum, n) => sum + n.votesCount * scaleY, 0) + (colNodes.length - 1) * nodeGap : 0;
      const colStartRealY = paddingTop + (graphHeight - totalColHeight) / 2;

      let currentY = colStartRealY;
      colNodes.forEach(node => {
        const nodeHeight = Math.max(5, node.votesCount * scaleY);
        node.x = x;
        node.y = currentY;
        node.height = nodeHeight;
        node.width = nodeWidth;
        node.inOffset = 0;
        node.outOffset = 0;
        nodeMap[node.id] = node;
        currentY += nodeHeight + nodeGap;
      });
    });

    links.sort((a, b) => {
      const nodeA_src = nodeMap[a.source];
      const nodeA_tgt = nodeMap[a.target];
      const nodeB_src = nodeMap[b.source];
      const nodeB_tgt = nodeMap[b.target];
      if (!nodeA_src || !nodeA_tgt || !nodeB_src || !nodeB_tgt) return 0;
      if (nodeA_src.y !== nodeB_src.y) return nodeA_src.y - nodeB_src.y;
      return nodeA_tgt.y - nodeB_tgt.y;
    });

    links.forEach(link => {
      const srcNode = nodeMap[link.source];
      const tgtNode = nodeMap[link.target];
      if (!srcNode || !tgtNode) return;
      const linkHeight = link.value * scaleY;

      link.x1 = srcNode.x + srcNode.width;
      link.y1 = srcNode.y + srcNode.outOffset + linkHeight / 2;
      link.h = linkHeight;

      link.x2 = tgtNode.x;
      link.y2 = tgtNode.y + tgtNode.inOffset + linkHeight / 2;

      srcNode.outOffset += linkHeight;
      tgtNode.inOffset += linkHeight;
    });

    const getOptionColor = (text) => {
      const clean = text.toLowerCase();
      if (clean === 'did not vote') return '#475569';
      if (clean === 'keep discussing') return '#64748b';
      if (clean === 'other') return '#a855f7';
      if (clean === 'yes') return '#10b981';
      if (clean === 'no') return '#f43f5e';
      if (clean === 'abstained') return '#64748b';
      
      const colors = [
        '#06b6d4', '#10b981', '#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#f43f5e', '#3b82f6'
      ];
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
      }
      const idx = Math.abs(hash) % colors.length;
      return colors[idx];
    };

    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 relative" ref={containerRef}>
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-200">Opinion Flow (Sankey Diagram)</h3>
              {onInfo && <InfoButton onClick={onInfo} label="More info about Opinion Flow (Sankey Diagram)" />}
            </div>
            <p className="text-xs text-slate-400 mt-1">Track voter transitions and consensus build-up from poll to poll.</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">Topic:</label>
                <select
                  value={sankeyTopic}
                  onChange={(e) => setSankeyTopic(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
                >
                  {availableSankeyTopics.map(topic => (
                    <option key={topic} value={topic}>{topic}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">Room:</label>
                <select
                  value={sankeyRoom}
                  onChange={(e) => setSankeyRoom(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
                >
                  <option value="all">All Rooms (Combined)</option>
                  {availableSankeyRooms.map(roomId => (
                    <option key={roomId} value={roomId}>{sankeyData[sankeyTopic]?.[roomId]?.roomName || roomId}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none hover:text-slate-200 transition-colors">
                <input
                  type="checkbox"
                  checked={showDidNotVote}
                  onChange={(e) => setShowDidNotVote(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                />
                Show "Did Not Vote"
              </label>

              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none hover:text-slate-200 transition-colors">
                <input
                  type="checkbox"
                  checked={showPersonalPhase}
                  onChange={(e) => setShowPersonalPhase(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                />
                Include Personal Rooms
              </label>

              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none hover:text-slate-200 transition-colors">
                <input
                  type="checkbox"
                  checked={showFinalDecision}
                  onChange={(e) => setShowFinalDecision(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                />
                Show Final Decision
              </label>
            </div>
          </div>
        </div>

        <div className="relative border border-slate-800/60 rounded-xl p-4 bg-slate-950/20 overflow-x-auto">
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto min-w-[700px] overflow-visible">
            {(() => {
              let groupCounter = 0;
              let convCounter = 0;
              let roundCounter = 0;
              return polls.map((p, idx) => {
                const x = paddingLeft + idx * dx + nodeWidth / 2;
                let label = '';
                if (p.isPersonalPhase) {
                  label = 'Personal Phase';
                } else if (p.isFinalDecision) {
                  label = 'Final Decision';
                } else if (p.isGroupPhase) {
                  groupCounter++;
                  label = `Group Rd ${groupCounter}`;
                } else if (p.isConvergencePhase) {
                  convCounter++;
                  label = `Conv Rd ${convCounter}`;
                } else {
                  roundCounter++;
                  label = `Round ${roundCounter}`;
                }

                return (
                  <g key={p.id}>
                    <text
                      x={x}
                      y={paddingTop - 32}
                      textAnchor="middle"
                      className="fill-slate-300 font-semibold text-[10px] uppercase tracking-wider"
                    >
                      {label}
                    </text>
                    <text
                      x={x}
                      y={paddingTop - 18}
                      textAnchor="middle"
                      className="fill-slate-500 font-mono text-[9px]"
                    >
                      {p.isPersonalPhase
                        ? 'Gathering Phase'
                        : (p.isFinalDecision
                          ? 'Convergence'
                          : (sankeyRoom === 'all' 
                            ? (p.isConvergencePhase ? 'Convergence Room' : 'Discussion Group') 
                            : `Poll #${p.id}`))
                      }
                    </text>
                    <title>{p.question}</title>
                  </g>
                );
              });
            })()}

            {/* Links drawing (separate visible and interactive layers) */}
            {links.map((link, idx) => {
              const srcNode = nodeMap[link.source];
              const tgtNode = nodeMap[link.target];
              const isNodeHovered = hoveredNode && (link.source === hoveredNode || link.target === hoveredNode);
              const isLinkHovered = hoveredLink && (hoveredLink.source === link.source && hoveredLink.target === link.target);
              
              const color = getOptionColor(srcNode.optionText);
              const opacity = isLinkHovered ? 0.85 : (hoveredNode ? (isNodeHovered ? 0.6 : 0.05) : 0.28);
              const pathString = `M ${link.x1} ${link.y1} C ${(link.x1 + link.x2) / 2} ${link.y1}, ${(link.x1 + link.x2) / 2} ${link.y2}, ${link.x2} ${link.y2}`;

              return (
                <g key={idx}>
                  {/* Visible path */}
                  <path
                    d={pathString}
                    stroke={color}
                    strokeWidth={Math.max(1.5, link.h)}
                    fill="none"
                    strokeOpacity={opacity}
                    className="transition-all duration-150 pointer-events-none"
                  />
                  {/* Invisible thicker path for mouse interaction */}
                  <path
                    d={pathString}
                    stroke="transparent"
                    strokeWidth={Math.max(12, link.h)}
                    fill="none"
                    className="cursor-pointer"
                    onMouseEnter={(e) => {
                      if (!containerRef.current) return;
                      const containerRect = containerRef.current.getBoundingClientRect();
                      setHoveredLink({
                        source: srcNode.optionText,
                        target: tgtNode.optionText,
                        value: link.value,
                        usernames: link.usernames,
                        x: e.clientX - containerRect.left + 15,
                        y: e.clientY - containerRect.top - 20
                      });
                    }}
                    onMouseMove={(e) => {
                      if (!containerRef.current) return;
                      const containerRect = containerRef.current.getBoundingClientRect();
                      setHoveredLink(prev => prev ? {
                        ...prev,
                        x: e.clientX - containerRect.left + 15,
                        y: e.clientY - containerRect.top - 20
                      } : null);
                    }}
                    onMouseLeave={() => setHoveredLink(null)}
                  />
                </g>
              );
            })}

            {/* Nodes drawing */}
            {columns.map((colNodes, colIdx) => (
              <g key={colIdx}>
                {colNodes.map(node => {
                  const isNodeHovered = hoveredNode === node.id;
                  const color = getOptionColor(node.optionText);
                  
                  return (
                    <g key={node.id} onMouseEnter={() => setHoveredNode(node.id)} onMouseLeave={() => setHoveredNode(null)}>
                      <rect
                        x={node.x}
                        y={node.y}
                        width={node.width}
                        height={node.height}
                        fill={color}
                        rx="1"
                        opacity={hoveredNode ? (isNodeHovered ? 1.0 : 0.4) : 0.85}
                        className="transition-opacity duration-150"
                      />
                      {(colIdx === 0 || colIdx === columns.length - 1 || isNodeHovered) && (
                        <text
                          x={colIdx === columns.length - 1 ? node.x - 8 : node.x + node.width + 8}
                          y={node.y + node.height / 2 + 3}
                          textAnchor={colIdx === columns.length - 1 ? 'end' : 'start'}
                          className={`fill-slate-300 font-sans text-[8.5px] max-w-[150px] transition-opacity duration-150 ${isNodeHovered ? 'fill-white font-semibold' : 'opacity-70'}`}
                        >
                          {node.optionText.length > 28 ? node.optionText.substring(0, 26) + '..' : node.optionText} ({node.votesCount})
                        </text>
                      )}
                      <title>{`${node.optionText}\nVotes: ${node.votesCount}`}</title>
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>

          {hoveredLink && (
            <div
              className="absolute z-10 bg-slate-950/95 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 pointer-events-none shadow-2xl max-w-[280px]"
              style={{ left: hoveredLink.x, top: hoveredLink.y }}
            >
              <div className="font-semibold text-blue-400 mb-1">
                {hoveredLink.value} User{hoveredLink.value > 1 ? 's' : ''}
              </div>
              <div className="mb-2 text-[10px] text-slate-400 leading-normal">
                from <span className="text-slate-300 font-medium">"{hoveredLink.source}"</span><br />
                to <span className="text-slate-300 font-medium">"{hoveredLink.target}"</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const RenderPlotlySankeyPlot = ({ onInfo }) => {
	    const sankeyData = stats?.sankeyData || {};
	    const availableSankeyTopics = Object.keys(sankeyData).sort();
	    const availableSankeyRooms = sankeyTopic && sankeyData[sankeyTopic]
	      ? Object.keys(sankeyData[sankeyTopic])
	          .filter((roomId) => {
	            const name = sankeyData[sankeyTopic][roomId]?.roomName || '';
	            return !name.toLowerCase().includes('personal');
	          })
	          .sort()
	      : [];

	    const selectedRooms = useMemo(() => {
	      if (!sankeyTopic || !sankeyData[sankeyTopic]) return [];
	      if (sankeyRoom === 'all') return Object.values(sankeyData[sankeyTopic]);
	      return sankeyData[sankeyTopic][sankeyRoom] ? [sankeyData[sankeyTopic][sankeyRoom]] : [];
	    }, [sankeyData, sankeyRoom, sankeyTopic]);

	    const normalizeOptionText = (text) => {
	      const clean = String(text || '').replace(/\s+/g, ' ').trim();
	      if (!clean) return 'Did Not Vote';
	      const lower = clean.toLowerCase();
	      if (lower === 'yes' || lower === 'yes.') return 'Yes';
	      if (lower === 'no' || lower === 'no.') return 'No';
	      if (lower === 'abstain' || lower === 'abstained') return 'Abstained';
	      if (lower === 'did not vote' || lower === 'didn’t vote' || lower === 'didnt vote') return 'Did Not Vote';
	      return clean;
	    };

	    const optionKey = (text) => normalizeOptionText(text).toLowerCase();

	    const getOptionColor = (text) => {
	      const clean = String(text || '').toLowerCase();
	      if (clean === 'did not vote') return '#64748b';
	      if (clean === 'keep discussing') return '#94a3b8';
	      if (clean === 'yes') return '#10b981';
	      if (clean === 'no') return '#f43f5e';
	      if (clean === 'abstained' || clean === 'abstain') return '#64748b';
	      const colors = ['#06b6d4', '#10b981', '#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#f43f5e', '#3b82f6', '#84cc16', '#eab308'];
	      let hash = 0;
	      for (let i = 0; i < clean.length; i += 1) {
	        hash = clean.charCodeAt(i) + ((hash << 5) - hash);
	      }
	      return colors[Math.abs(hash) % colors.length];
	    };

	    const toRgba = (hex, alpha) => {
	      const normalized = String(hex || '').replace('#', '');
	      if (normalized.length !== 6) return `rgba(148, 163, 184, ${alpha})`;
	      const r = parseInt(normalized.slice(0, 2), 16);
	      const g = parseInt(normalized.slice(2, 4), 16);
	      const b = parseInt(normalized.slice(4, 6), 16);
	      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	    };

	    const plotlyGraph = useMemo(() => {
	      const stageMap = new Map();
	      const userStageMap = new Map();

	      const includePoll = (poll) => {
	        if (!showPersonalPhase && poll?.isPersonalPhase) return false;
	        if (!showFinalDecision && poll?.isFinalDecision) return false;
	        return true;
	      };

	      const stageForPoll = (poll, visibleIndex) => {
	        if (poll?.isPersonalPhase) return { key: 'personal', label: 'Personal', sort: 0 };
	        if (poll?.isFinalDecision) return { key: 'final', label: 'Final', sort: 1_000_000 };
	        if (poll?.isConvergencePhase || /convergence/i.test(String(poll?.question || ''))) {
	          return { key: `convergence-${visibleIndex}`, label: `Convergence ${visibleIndex + 1}`, sort: visibleIndex + 1 };
	        }
	        return { key: `round-${visibleIndex}`, label: `Round ${visibleIndex + 1}`, sort: visibleIndex + 1 };
	      };

	      const rememberStage = (stage) => {
	        const existing = stageMap.get(stage.key);
	        if (!existing || stage.sort < existing.sort) stageMap.set(stage.key, stage);
	      };

	      const rememberUserStage = (userKey, item) => {
	        if (!userStageMap.has(userKey)) {
	          userStageMap.set(userKey, { username: item.username, stages: new Map() });
	        }
	        const userRecord = userStageMap.get(userKey);
	        const existing = userRecord.stages.get(item.stageKey);
	        if (!existing) {
	          userRecord.stages.set(item.stageKey, item);
	          return;
	        }
	        const existingIsMissing = existing.optionText === 'Did Not Vote';
	        const nextIsPresent = item.optionText !== 'Did Not Vote';
	        const existingTime = new Date(existing.createdAt || 0).getTime();
	        const nextTime = new Date(item.createdAt || 0).getTime();
	        if ((existingIsMissing && nextIsPresent) || nextTime >= existingTime) {
	          userRecord.stages.set(item.stageKey, item);
	        }
	      };

	      for (const room of selectedRooms) {
	        const polls = Array.isArray(room?.polls) ? room.polls : [];
	        const visiblePollEntries = polls
	          .map((poll, index) => ({ poll, originalIndex: index }))
	          .filter(({ poll }) => includePoll(poll));

	        visiblePollEntries.forEach(({ poll }, visibleIndex) => {
	          rememberStage(stageForPoll(poll, visibleIndex));
	        });

	        for (const [rawUserId, user] of Object.entries(room?.userVotes || {})) {
	          const userKey = String(rawUserId || user?.username || 'unknown');
	          for (const { poll, originalIndex } of visiblePollEntries) {
	            const visibleIndex = visiblePollEntries.findIndex(entry => entry.originalIndex === originalIndex);
	            const stage = stageForPoll(poll, visibleIndex);
	            const optionText = normalizeOptionText(user?.votes?.[originalIndex]?.optionText);
	            if (poll?.isPersonalPhase && optionText === 'Did Not Vote') continue;
	            if (!showDidNotVote && optionText === 'Did Not Vote') continue;
	            rememberUserStage(userKey, {
	              stageKey: stage.key,
	              optionText,
	              optionKey: optionKey(optionText),
	              username: user?.username || 'unknown user',
	              createdAt: poll?.created_at || ''
	            });
	          }
	        }
	      }

	      const stages = [...stageMap.values()].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
	      const stageIndex = new Map(stages.map((stage, index) => [stage.key, index]));
	      const nodeMap = new Map();
	      const linkMap = new Map();

	      for (const userRecord of userStageMap.values()) {
	        const sequence = [...userRecord.stages.values()]
	          .filter(item => stageIndex.has(item.stageKey))
	          .map(item => ({ ...item, step: stageIndex.get(item.stageKey) }))
	          .sort((a, b) => a.step - b.step);

	        for (const item of sequence) {
	          const nodeId = `${item.step}::${item.optionKey}`;
	          if (!nodeMap.has(nodeId)) {
	            nodeMap.set(nodeId, {
	              id: nodeId,
	              label: item.optionText,
	              step: item.step,
	              voters: new Set()
	            });
	          }
	          nodeMap.get(nodeId).voters.add(userRecord.username);
	        }

	        for (let index = 0; index < sequence.length - 1; index += 1) {
	          const source = `${sequence[index].step}::${sequence[index].optionKey}`;
	          const target = `${sequence[index + 1].step}::${sequence[index + 1].optionKey}`;
	          const linkKey = `${source}=>${target}`;
	          if (!linkMap.has(linkKey)) {
	            linkMap.set(linkKey, {
	              key: linkKey,
	              source,
	              target,
	              value: 0,
	              usernames: [],
	              sourceLabel: sequence[index].optionText,
	              targetLabel: sequence[index + 1].optionText
	            });
	          }
	          const link = linkMap.get(linkKey);
	          link.value += 1;
	          link.usernames.push(userRecord.username);
	        }
	      }

	      const nodes = [...nodeMap.values()]
	        .sort((a, b) => a.step - b.step || b.voters.size - a.voters.size || a.label.localeCompare(b.label));
	      const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
	      const nodesByStep = nodes.reduce((acc, node) => {
	        if (!acc.has(node.step)) acc.set(node.step, []);
	        acc.get(node.step).push(node);
	        return acc;
	      }, new Map());

	      const maxStep = Math.max(0, stages.length - 1);
	      const nodeX = [];
	      const nodeY = [];
	      for (const node of nodes) {
	        const peers = nodesByStep.get(node.step) || [];
	        const position = Math.max(0, peers.findIndex(peer => peer.id === node.id));
	        nodeX.push(maxStep === 0 ? 0.5 : Math.min(0.98, Math.max(0.02, node.step / maxStep)));
	        nodeY.push(peers.length <= 1 ? 0.5 : Math.min(0.95, Math.max(0.05, (position + 0.5) / peers.length)));
	      }

	      const links = [...linkMap.values()].filter(link => nodeIndex.has(link.source) && nodeIndex.has(link.target));
	      const linkSources = links.map(link => nodeIndex.get(link.source));
	      const linkTargets = links.map(link => nodeIndex.get(link.target));
	      const linkValues = links.map(link => link.value);
	      const linkColors = links.map(link => toRgba(getOptionColor(link.sourceLabel), 0.38));
	      const linkHover = links.map(link => {
	        const users = link.usernames.join(', ');
	        return `<b>${link.sourceLabel} -> ${link.targetLabel}</b><br>${link.value} user${link.value === 1 ? '' : 's'}<br>${users}`;
	      });

	      const nodeLabels = nodes.map(node => node.label);
	      const nodeColors = nodes.map(node => getOptionColor(node.label));
	      const nodeHover = nodes.map(node => {
	        const voters = [...node.voters].sort();
	        return `<b>${node.label}</b><br>${voters.length} user${voters.length === 1 ? '' : 's'}<br>${voters.join(', ')}`;
	      });

	      return {
	        empty: nodes.length === 0 || links.length === 0,
	        stageLabels: stages.map(stage => stage.label),
	        nodeLabels,
	        nodeColors,
	        nodeHover,
	        nodeX,
	        nodeY,
	        linkSources,
	        linkTargets,
	        linkValues,
	        linkColors,
	        linkHover
	      };
	    }, [selectedRooms, showDidNotVote, showFinalDecision, showPersonalPhase]);

	    const EmptyState = ({ text }) => (
	      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
	        <div className="mb-2 flex items-center justify-between gap-3">
	          <h3 className="text-sm font-semibold text-slate-200">Opinion Flow</h3>
	          {onInfo && <InfoButton onClick={onInfo} label="More info about Opinion Flow" />}
	        </div>
	        <p className="text-xs text-slate-400 mb-4">Select a topic and room to inspect how users move between options over time.</p>
	        <div className="flex h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-950/30 text-sm text-slate-500">
	          <span className="mb-2 text-3xl text-slate-700">~</span>
	          {text}
	        </div>
	      </div>
	    );

	    if (!availableSankeyTopics.length) return <EmptyState text="No vote-flow data available yet." />;

	    return (
	      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl shadow-black/10">
	        <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
	          <div>
	            <div className="flex items-center gap-2">
	              <h3 className="text-base font-semibold text-slate-100">Opinion Flow</h3>
	              {onInfo && <InfoButton onClick={onInfo} label="More info about Opinion Flow" />}
	              <span className="rounded-full border border-cyan-800/60 bg-cyan-950/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-300">Plotly Sankey</span>
	            </div>
	            <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-400">
	              Drag nodes to rearrange the flow, use the Plotly toolbar to zoom or reset, and hover nodes or links for participant details.
	            </p>
	          </div>

	          <div className="flex flex-wrap items-center gap-3">
	            <select value={sankeyTopic} onChange={(e) => setSankeyTopic(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-500 focus:outline-none">
	              {availableSankeyTopics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
	            </select>
	            <select value={sankeyRoom} onChange={(e) => setSankeyRoom(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-500 focus:outline-none">
	              <option value="all">All Rooms</option>
	              {availableSankeyRooms.map((roomId) => <option key={roomId} value={roomId}>{sankeyData[sankeyTopic]?.[roomId]?.roomName || roomId}</option>)}
	            </select>
	          </div>
	        </div>

	        <div className="mb-4 flex flex-wrap gap-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
	          {[
	            ['Show Did Not Vote', showDidNotVote, setShowDidNotVote],
	            ['Include Personal Rooms', showPersonalPhase, setShowPersonalPhase],
	            ['Show Final Decision', showFinalDecision, setShowFinalDecision]
	          ].map(([label, checked, setter]) => (
	            <label key={label} className="flex cursor-pointer items-center gap-2 text-xs text-slate-400 hover:text-slate-200">
	              <input
	                type="checkbox"
	                checked={checked}
	                onChange={(event) => setter(event.target.checked)}
	                className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0 focus:ring-offset-0"
	              />
	              {label}
	            </label>
	          ))}
	        </div>

	        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
	          {plotlyGraph.empty ? (
	            <div className="flex h-80 items-center justify-center text-sm text-slate-500">
	              No transitions available with the current filters.
	            </div>
	          ) : (
	            <Plot
	              data={[{
	                type: 'sankey',
	                arrangement: 'freeform',
	                orientation: 'h',
	                valueformat: '.0f',
	                valuesuffix: ' users',
	                node: {
	                  pad: 20,
	                  thickness: 18,
	                  line: { color: 'rgba(226,232,240,0.35)', width: 0.8 },
	                  label: plotlyGraph.nodeLabels,
	                  color: plotlyGraph.nodeColors,
	                  customdata: plotlyGraph.nodeHover,
	                  hovertemplate: '%{customdata}<extra></extra>',
	                  x: plotlyGraph.nodeX,
	                  y: plotlyGraph.nodeY
	                },
	                link: {
	                  source: plotlyGraph.linkSources,
	                  target: plotlyGraph.linkTargets,
	                  value: plotlyGraph.linkValues,
	                  color: plotlyGraph.linkColors,
	                  customdata: plotlyGraph.linkHover,
	                  hovertemplate: '%{customdata}<extra></extra>'
	                }
	              }]}
	              layout={{
	                autosize: true,
	                height: 640,
	                dragmode: false,
	                paper_bgcolor: 'rgba(2,6,23,1)',
	                plot_bgcolor: 'rgba(2,6,23,1)',
	                font: { color: '#e2e8f0', family: 'ui-sans-serif, system-ui, sans-serif', size: 12 },
	                margin: { l: 18, r: 18, t: 56, b: 18 },
	                hoverlabel: {
	                  bgcolor: 'rgba(2,6,23,0.88)',
	                  bordercolor: 'rgba(148,163,184,0.45)',
	                  font: { color: '#f8fafc', size: 13 }
	                },
	                annotations: plotlyGraph.stageLabels.map((label, index) => ({
	                  x: plotlyGraph.stageLabels.length <= 1 ? 0.5 : index / (plotlyGraph.stageLabels.length - 1),
	                  y: 1.08,
	                  xref: 'paper',
	                  yref: 'paper',
	                  text: `<b>${label}</b>`,
	                  showarrow: false,
	                  font: { color: '#cbd5e1', size: 12 }
	                }))
	              }}
	              config={{
	                responsive: true,
	                displaylogo: false,
	                scrollZoom: true,
	                modeBarButtonsToRemove: ['lasso2d', 'select2d']
	              }}
	              style={{ width: '100%', height: '640px' }}
	              useResizeHandler
	            />
	          )}
	        </div>

	        <div className="mt-4 grid gap-3 text-xs text-slate-400 md:grid-cols-3">
	          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
	            <span className="block font-semibold text-slate-200">Draggable nodes</span>
	            Plotly's freeform Sankey layout lets you drag nodes to reduce overlap.
	          </div>
	          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
	            <span className="block font-semibold text-slate-200">Native hover</span>
	            Tooltips and hit testing are handled by Plotly instead of custom SVG overlays.
	          </div>
	          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
	            <span className="block font-semibold text-slate-200">Participant-safe counts</span>
	            Each participant contributes at most one vote per stage.
	          </div>
	        </div>
	      </div>
	    );
	  };

	  return (
	    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-800 pb-5">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-100 font-sans">Quality Analytics</h2>
          <p className="text-sm text-slate-400 mt-1">Review statistical and scientific metrics. Datapoints are binned at 1-minute intervals for experiment monitoring.</p>
        </div>
        <div className="flex items-center gap-3">
          {stats && (
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium border ${stats.experimentActive ? 'bg-emerald-950/45 text-emerald-400 border-emerald-800/40 animate-pulse' : 'bg-slate-800/45 text-slate-400 border-slate-700/50'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${stats.experimentActive ? 'bg-emerald-500' : 'bg-slate-500'}`} />
              {stats.experimentActive ? 'Recording Active' : 'Recording Capped (Experiment Ended)'}
            </span>
          )}
          <button
            onClick={() => fetchStats(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            Refresh Data
          </button>
          <button
            onClick={downloadComputedRunData}
            disabled={downloading}
            title="Download the current run data already stored by CIME. No new quality analysis is started."
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 shadow hover:border-cyan-500 hover:bg-slate-700 disabled:cursor-wait disabled:opacity-60 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
            </svg>
            {downloading ? 'Preparing download...' : 'Download computed run data'}
          </button>
        </div>
      </div>

      {downloadError && (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 px-3 py-2 text-xs text-red-300" role="alert">
          Could not download computed run data: {downloadError}
        </div>
      )}

      {/* Filter & View Mode Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="h-4 w-4 text-slate-400">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
            </svg>
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Filters</span>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">Topic:</label>
            <select
              id="quality-filter-topic"
              value={selectedTopic}
              onChange={(e) => setSelectedTopic(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[160px]"
            >
              <option value="">All Topics</option>
              {filters.availableTopics.map(topic => (
                <option key={topic} value={topic}>{topic}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">Room Type:</label>
            <select
              id="quality-filter-room-type"
              value={selectedRoomType}
              onChange={(e) => setSelectedRoomType(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[140px]"
            >
              <option value="">All Room Types</option>
              {filters.availableRoomTypes.map(rt => (
                <option key={rt} value={rt}>{rt.charAt(0).toUpperCase() + rt.slice(1)}</option>
              ))}
            </select>
          </div>

          {(selectedTopic || selectedRoomType) && (
            <button
              onClick={() => { setSelectedTopic(''); setSelectedRoomType(''); }}
              className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
            >
              Clear Filters
            </button>
          )}
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-1.5 bg-slate-950/60 p-1 rounded-lg border border-slate-800 self-start lg:self-center">
          <button
            onClick={() => setViewMode('timeSeries')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${viewMode === 'timeSeries' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Time Series
          </button>
          <button
            onClick={() => setViewMode('compareTopics')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${viewMode === 'compareTopics' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Compare Topics
          </button>
          <button
            onClick={() => setViewMode('compareRooms')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${viewMode === 'compareRooms' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Compare Rooms
          </button>
        </div>
      </div>

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          title={metricInfo.deliberativeQuality.title}
          value={toPercent(deliberativeQuality.score || 0)}
          detail={`${deliberativeQuality.messageCount || 0} analyzed messages`}
          accentClass="border-teal-800/50 bg-teal-900/25"
          valueClass="text-teal-100"
          detailClass="text-teal-300/70"
          spanClass="xl:col-span-2"
          onInfo={() => openInfoModal(metricInfo.deliberativeQuality.title, metricInfo.deliberativeQuality.description, metricInfo.deliberativeQuality.notes)}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[
              ['Equality', deliberativeDimensions.participationEquality || 0, 'text-emerald-300'],
              ['Justification', deliberativeDimensions.justification || 0, 'text-sky-300'],
              ['Listening', deliberativeDimensions.reciprocity || 0, 'text-cyan-300'],
              ['Respect', deliberativeDimensions.respect || 0, 'text-violet-300'],
              ['Constructive', deliberativeDimensions.constructiveness || 0, 'text-amber-300'],
              ['Evidence', deliberativeDimensions.epistemicOrientation || 0, 'text-teal-300']
            ].map(([label, rate, colorClass]) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
                <div className={`mt-1 text-sm font-semibold ${colorClass}`}>{toPercent(rate)}</div>
              </div>
            ))}
          </div>
        </MetricCard>

        <MetricCard
          title={metricInfo.consensusPassRate.title}
          value={toPercent(summary.passedPollsRatio)}
          detail={`(${summary.totalPassedPolls}/${summary.totalResolvedPolls})`}
          onInfo={() => openInfoModal(metricInfo.consensusPassRate.title, metricInfo.consensusPassRate.description, metricInfo.consensusPassRate.notes)}
        />

        <MetricCard
          title={metricInfo.topicsPassedFirstTry.title}
          value={toPercent(summary.firstTrySuccessRate)}
          detail={`(${summary.topicsPassedFirstTry}/${summary.topicsCount})`}
          onInfo={() => openInfoModal(metricInfo.topicsPassedFirstTry.title, metricInfo.topicsPassedFirstTry.description, metricInfo.topicsPassedFirstTry.notes)}
        />

        <MetricCard
          title={metricInfo.suggestedOptionsWon.title}
          value={summary.suggestionsWon}
          detail="polls won"
          onInfo={() => openInfoModal(metricInfo.suggestedOptionsWon.title, metricInfo.suggestedOptionsWon.description, metricInfo.suggestedOptionsWon.notes)}
        />

        <MetricCard
          title={metricInfo.botMessages.title}
          value={summary.totalBotMessages}
          detail="total"
          accentClass="border-violet-800/50 bg-violet-900/20"
          valueClass="text-slate-100"
          detailClass="text-slate-500"
          onInfo={() => openInfoModal(metricInfo.botMessages.title, metricInfo.botMessages.description, metricInfo.botMessages.notes)}
        />

        <MetricCard
          title={metricInfo.optionSwitches.title}
          value={summary.totalOptionSwitches}
          detail={`(${toPercent(summary.optionSwitchRate)})`}
          accentClass="border-orange-800/50 bg-orange-900/20"
          valueClass="text-slate-100"
          detailClass="text-slate-500"
          onInfo={() => openInfoModal(metricInfo.optionSwitches.title, metricInfo.optionSwitches.description, metricInfo.optionSwitches.notes)}
        />

        <MetricCard
          title={metricInfo.opinionMixing.title}
          value={toPercent(summary.opinionMixingIndex)}
          detail={`(${toPercent(summary.opinionMixingCoverage)} coverage)`}
          accentClass="border-fuchsia-800/50 bg-fuchsia-900/20"
          valueClass="text-slate-100"
          detailClass="text-slate-500"
          onInfo={() => openInfoModal(metricInfo.opinionMixing.title, metricInfo.opinionMixing.description, metricInfo.opinionMixing.notes)}
        />

        <MetricCard
          title={metricInfo.avgWordsPerMessage.title}
          value={summary.avgWordsPerMessage}
          detail="words"
          accentClass="border-blue-800/50 bg-blue-900/25"
          valueClass="text-slate-100"
          detailClass="text-slate-500"
          onInfo={() => openInfoModal(metricInfo.avgWordsPerMessage.title, metricInfo.avgWordsPerMessage.description, metricInfo.avgWordsPerMessage.notes)}
        />

        <MetricCard
          title={metricInfo.avgVotesPerTopic.title}
          value={summary.avgVotesPerTopic}
          detail="votes / topic"
          onInfo={() => openInfoModal(metricInfo.avgVotesPerTopic.title, metricInfo.avgVotesPerTopic.description, metricInfo.avgVotesPerTopic.notes)}
        />

        <MetricCard
          title={metricInfo.avgPollsPerTopic.title}
          value={summary.avgPollsPerTopic}
          detail="polls / topic"
          onInfo={() => openInfoModal(metricInfo.avgPollsPerTopic.title, metricInfo.avgPollsPerTopic.description, metricInfo.avgPollsPerTopic.notes)}
        />
      </div>

      <div className="mt-4">
        <MetricCard
          title={metricInfo.newOptionsSuggested.title}
          value={summary.totalSuggestions}
          detail={`(${summary.uniqueSuggestionsCount} unique)`}
          onInfo={() => openInfoModal(metricInfo.newOptionsSuggested.title, metricInfo.newOptionsSuggested.description, metricInfo.newOptionsSuggested.notes)}
        >
          <div className="grid grid-cols-2 gap-2">
            {[
              ['Extension', summary.newOptionsSuggested?.extensionRate ?? 0, 'text-emerald-300'],
              ['Contradiction', summary.newOptionsSuggested?.contradictionRate ?? 0, 'text-rose-300'],
              ['Combination', summary.newOptionsSuggested?.combinationRate ?? 0, 'text-cyan-300'],
              ['Unrelated', summary.newOptionsSuggested?.unrelatedRate ?? 0, 'text-slate-300']
            ].map(([label, rate, colorClass]) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
                <div className={`mt-1 text-sm font-semibold ${colorClass}`}>{toPercent(rate)}</div>
              </div>
            ))}
          </div>
        </MetricCard>
      </div>

      <div className="mt-4">
        <MetricCard
          title={metricInfo.proactiveness.title}
          value={toPercent((summary.proactiveness || summary.constructiveProposal || {}).rate || 0)}
          detail={`(${toPercent((summary.proactiveness || summary.constructiveProposal || {}).propositiveUsersRate || 0)} of users > 0.5)`}
          accentClass="border-emerald-800/50 bg-emerald-900/20"
          valueClass="text-slate-100"
          detailClass="text-slate-500"
          onInfo={() => openInfoModal(metricInfo.proactiveness.title, metricInfo.proactiveness.description, metricInfo.proactiveness.notes)}
        >
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              ['Support', (summary.proactiveness || summary.constructiveProposal)?.supportRate ?? 0, 'text-sky-300'],
              ['Opposition', (summary.proactiveness || summary.constructiveProposal)?.oppositionRate ?? 0, 'text-rose-300'],
              ['Modification', (summary.proactiveness || summary.constructiveProposal)?.modificationRate ?? 0, 'text-emerald-300'],
              ['Mitigation', (summary.proactiveness || summary.constructiveProposal)?.mitigationRate ?? 0, 'text-cyan-300'],
              ['Neutral', (summary.proactiveness || summary.constructiveProposal)?.neutralRate ?? 0, 'text-slate-300']
            ].map(([label, rate, colorClass]) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
                <div className={`mt-1 text-sm font-semibold ${colorClass}`}>{toPercent(rate)}</div>
              </div>
            ))}
          </div>
        </MetricCard>
      </div>

      {/* Secondary Summary Metadata Row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 border-y border-slate-800/60 py-4">
        <div>
          <span className="text-xs font-medium text-slate-500">Total Polls Created</span>
          <div className="text-lg font-semibold text-slate-300 mt-0.5">{summary.totalPolls} <span className="text-xs font-normal text-slate-500">({summary.totalRankingPolls} ranking)</span></div>
        </div>
        <div>
          <span className="text-xs font-medium text-slate-500">Failed Polls (0 Votes)</span>
          <div className="text-lg font-semibold text-rose-400 mt-0.5">{summary.failedPolls} <span className="text-xs font-normal text-slate-500">({toPercent(summary.failedPollsRatio)})</span></div>
        </div>
        <div>
          <span className="text-xs font-medium text-slate-500">Tied Polls</span>
          <div className="text-lg font-semibold text-cyan-400 mt-0.5">{summary.tiePolls} <span className="text-xs font-normal text-slate-500">({toPercent(summary.tiePollsRatio)})</span></div>
        </div>
        <div>
          <span className="text-xs font-medium text-slate-500">Participation Equality</span>
          <div className="text-lg font-semibold text-emerald-400 mt-0.5">{toPercent(1 - summary.globalGiniCoefficient)} <span className="text-xs font-normal text-slate-500">(Gini: {summary.globalGiniCoefficient.toFixed(3)})</span></div>
        </div>
        <div>
          <span className="text-xs font-medium text-slate-500">Human Messages</span>
          <div className="text-lg font-semibold text-slate-300 mt-0.5">{summary.totalMessages} <span className="text-xs font-normal text-slate-500">({summary.totalUsers} users)</span></div>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {viewMode === 'timeSeries' ? (
          <>
            {/* Consensus Polls Percentage Chart */}
            <RenderSvgChart
              id="passed-ratio"
              title={chartInfo.passedRatio.title}
              yKey="passedPollsRatio"
              colorClass="text-sky-400"
              strokeColor="#38bdf8"
              fillColor="#38bdf8"
              gradientId="grad-passed-ratio"
              maxValueOverride={1.0}
              isRatio={true}
              description={chartInfo.passedRatio.description}
              onInfo={() => openInfoModal(chartInfo.passedRatio.title, chartInfo.passedRatio.description, chartInfo.passedRatio.notes)}
            />

            <RenderSvgChart
              id="deliberative-quality"
              title={chartInfo.deliberativeQuality.title}
              yKey="deliberativeQuality"
              colorClass="text-teal-400"
              strokeColor="#14b8a6"
              fillColor="#14b8a6"
              gradientId="grad-deliberative-quality"
              maxValueOverride={1.0}
              isRatio={true}
              description={chartInfo.deliberativeQuality.description}
              onInfo={() => openInfoModal(chartInfo.deliberativeQuality.title, chartInfo.deliberativeQuality.description, chartInfo.deliberativeQuality.notes)}
            />

            {/* Vote Disagreement (Entropy) Chart */}
            <RenderSvgChart
              id="entropy"
              title={chartInfo.entropy.title}
              yKey="avgEntropy"
              colorClass="text-indigo-400"
              strokeColor="#6366f1"
              fillColor="#6366f1"
              gradientId="grad-entropy"
              maxValueOverride={1.0}
              description={chartInfo.entropy.description}
              onInfo={() => openInfoModal(chartInfo.entropy.title, chartInfo.entropy.description, chartInfo.entropy.notes)}
            />

            {/* Engagement Inequality (Gini Index) Chart */}
            <RenderSvgChart
              id="gini"
              title={chartInfo.gini.title}
              yKey="giniCoefficient"
              colorClass="text-emerald-400"
              strokeColor="#10b981"
              fillColor="#10b981"
              gradientId="grad-gini"
              maxValueOverride={1.0}
              description={chartInfo.gini.description}
              onInfo={() => openInfoModal(chartInfo.gini.title, chartInfo.gini.description, chartInfo.gini.notes)}
            />

            {/* Activity Volume Chart */}
            <RenderSvgChart
              id="activity"
              title={chartInfo.activity.title}
              yKey="messageCount"
              colorClass="text-amber-400"
              strokeColor="#f59e0b"
              fillColor="#f59e0b"
              gradientId="grad-activity"
              description={chartInfo.activity.description}
              onInfo={() => openInfoModal(chartInfo.activity.title, chartInfo.activity.description, chartInfo.activity.notes)}
            />

            {/* Bot Messages Chart */}
            <RenderSvgChart
              id="bot-messages"
              title={chartInfo.botMessages.title}
              yKey="botMessageCount"
              colorClass="text-violet-400"
              strokeColor="#8b5cf6"
              fillColor="#8b5cf6"
              gradientId="grad-bot"
              description={chartInfo.botMessages.description}
              onInfo={() => openInfoModal(chartInfo.botMessages.title, chartInfo.botMessages.description, chartInfo.botMessages.notes)}
            />

            {/* Option Switch Rate Chart */}
            <RenderSvgChart
              id="option-switch"
              title={chartInfo.optionSwitch.title}
              yKey="optionSwitchRate"
              colorClass="text-orange-400"
              strokeColor="#f97316"
              fillColor="#f97316"
              gradientId="grad-switch"
              maxValueOverride={1.0}
              isRatio={true}
              description={chartInfo.optionSwitch.description}
              onInfo={() => openInfoModal(chartInfo.optionSwitch.title, chartInfo.optionSwitch.description, chartInfo.optionSwitch.notes)}
            />

            {/* Average Words per Message Chart */}
            <RenderSvgChart
              id="avg-words"
              title={chartInfo.avgWords.title}
              yKey="avgWordsPerMessage"
              colorClass="text-blue-400"
              strokeColor="#3b82f6"
              fillColor="#3b82f6"
              gradientId="grad-words"
              description={chartInfo.avgWords.description}
              onInfo={() => openInfoModal(chartInfo.avgWords.title, chartInfo.avgWords.description, chartInfo.avgWords.notes)}
            />
          </>
        ) : (
          // Comparison Mode charts
          <>
            <RenderCompareChart
              id="compare-deliberative-quality"
              title={chartInfo.compareDeliberativeQuality.title}
              yKey="deliberativeQuality"
              colorClass="text-teal-400"
              strokeColor="#14b8a6"
              fillColor="#14b8a6"
              isRatio={true}
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareDeliberativeQuality.description}
              onInfo={() => openInfoModal(chartInfo.compareDeliberativeQuality.title, chartInfo.compareDeliberativeQuality.description, chartInfo.compareDeliberativeQuality.notes)}
            />

            <RenderCompareChart
              id="compare-consensus"
              title={chartInfo.compareConsensus.title}
              yKey="passedPollsRatio"
              colorClass="text-sky-400"
              strokeColor="#38bdf8"
              fillColor="#38bdf8"
              isRatio={true}
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareConsensus.description}
              onInfo={() => openInfoModal(chartInfo.compareConsensus.title, chartInfo.compareConsensus.description, chartInfo.compareConsensus.notes)}
            />

            <RenderCompareChart
              id="compare-entropy"
              title={chartInfo.compareEntropy.title}
              yKey="avgEntropy"
              colorClass="text-indigo-400"
              strokeColor="#6366f1"
              fillColor="#6366f1"
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareEntropy.description}
              onInfo={() => openInfoModal(chartInfo.compareEntropy.title, chartInfo.compareEntropy.description, chartInfo.compareEntropy.notes)}
            />

            <RenderCompareChart
              id="compare-gini"
              title={chartInfo.compareGini.title}
              yKey="giniCoefficient"
              colorClass="text-emerald-400"
              strokeColor="#10b981"
              fillColor="#10b981"
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareGini.description}
              onInfo={() => openInfoModal(chartInfo.compareGini.title, chartInfo.compareGini.description, chartInfo.compareGini.notes)}
            />

            <RenderCompareChart
              id="compare-messages"
              title={chartInfo.compareMessages.title}
              yKey="messageCount"
              colorClass="text-amber-400"
              strokeColor="#f59e0b"
              fillColor="#f59e0b"
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareMessages.description}
              onInfo={() => openInfoModal(chartInfo.compareMessages.title, chartInfo.compareMessages.description, chartInfo.compareMessages.notes)}
            />

            <RenderCompareChart
              id="compare-bot"
              title={chartInfo.compareBot.title}
              yKey="botMessageCount"
              colorClass="text-violet-400"
              strokeColor="#8b5cf6"
              fillColor="#8b5cf6"
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareBot.description}
              onInfo={() => openInfoModal(chartInfo.compareBot.title, chartInfo.compareBot.description, chartInfo.compareBot.notes)}
            />

            <RenderCompareChart
              id="compare-switches"
              title={chartInfo.compareSwitches.title}
              yKey="optionSwitchRate"
              colorClass="text-orange-400"
              strokeColor="#f97316"
              fillColor="#f97316"
              isRatio={true}
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareSwitches.description}
              onInfo={() => openInfoModal(chartInfo.compareSwitches.title, chartInfo.compareSwitches.description, chartInfo.compareSwitches.notes)}
            />

            <RenderCompareChart
              id="compare-mixing"
              title={chartInfo.compareMixing.title}
              yKey="opinionMixingIndex"
              colorClass="text-fuchsia-400"
              strokeColor="#d946ef"
              fillColor="#d946ef"
              isRatio={true}
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareMixing.description}
              onInfo={() => openInfoModal(chartInfo.compareMixing.title, chartInfo.compareMixing.description, chartInfo.compareMixing.notes)}
            />

            <RenderCompareChart
              id="compare-words"
              title={chartInfo.compareWords.title}
              yKey="avgWordsPerMessage"
              colorClass="text-blue-400"
              strokeColor="#3b82f6"
              fillColor="#3b82f6"
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareWords.description}
              onInfo={() => openInfoModal(chartInfo.compareWords.title, chartInfo.compareWords.description, chartInfo.compareWords.notes)}
            />

            <RenderCompareChart
              id="compare-suggestions"
              title={chartInfo.compareSuggestions.title}
              yKey="suggestionsCount"
              colorClass="text-rose-400"
              strokeColor="#f43f5e"
              fillColor="#f43f5e"
              data={viewMode === 'compareTopics' ? stats.topicsComparison : stats.roomsComparison}
              categoryKey={viewMode === 'compareTopics' ? 'topic' : 'roomId'}
              description={chartInfo.compareSuggestions.description}
              onInfo={() => openInfoModal(chartInfo.compareSuggestions.title, chartInfo.compareSuggestions.description, chartInfo.compareSuggestions.notes)}
            />
          </>
        )}
      </div>

      {/* Sankey Plot Section */}
      <RenderPlotlySankeyPlot
        onInfo={() => openInfoModal(chartInfo.sankey.title, chartInfo.sankey.description, chartInfo.sankey.notes)}
      />

      <InfoModal />

      {/* Scientific Methodology Card */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="h-4 w-4 text-blue-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
          </svg>
          Scientific Methodology
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 text-xs text-slate-400 leading-relaxed">
          <div className="bg-slate-800/40 rounded-lg p-3">
            <span className="text-teal-400 font-semibold block mb-1">Deliberative Quality Composite</span>
            Weighted process score inspired by DQI and AQuA. Participation equality is structural; justification, listening, respect, constructiveness, and epistemic orientation are scored with cached LLM rubric calls plus embedding-based semantic relevance/responsiveness signals.
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <span className="text-indigo-400 font-semibold block mb-1">Shannon Entropy (Fragmentation)</span>
            H = −Σ pᵢ log₂(pᵢ), normalized to [0,1] by dividing by log₂(M) where M = number of options. Used in information theory (Shannon, 1948) and political science to quantify opinion diversity in group decisions.
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <span className="text-emerald-400 font-semibold block mb-1">Gini Coefficient (Participation)</span>
            G = Σᵢ Σⱼ |xᵢ − xⱼ| / (2n²μ). Borrowed from economics (Gini, 1912) to measure equality of participation. A Gini of 0 means perfect equality; 1 means one person dominates.
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <span className="text-orange-400 font-semibold block mb-1">Option Switching (Volatility)</span>
            Measures preference instability across consecutive polls on the same topic. A user "switches" when their top-ranked option changes between poll rounds. High rates suggest active deliberation and persuasion effects.
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <span className="text-fuchsia-400 font-semibold block mb-1">Opinion Mixing Index</span>
            Compares each participant's first and last comparable stance in a topic or room. When ranking polls exist, the metric uses a Kendall-like order reshuffle score; otherwise it falls back to a choice-drift comparison that still captures whether people moved toward different alternatives over time. Values closer to 1 mean stronger reshuffling and more cross-over of positions.
          </div>
        </div>
      </div>
    </div>
  );
}
