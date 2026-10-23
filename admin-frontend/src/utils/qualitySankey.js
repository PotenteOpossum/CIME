export function stageForPoll(poll, index, roomType) {
  if (poll?.isPersonalPhase)
    return { key: "personal", label: "Personal", sort: 0 };
  if (poll?.isFinalDecision)
    return {
      key: "final",
      label: "Final decision (separate question)",
      sort: 1_000_000,
    };
  if (roomType === "convergence" || poll?.isConvergencePhase)
    return {
      key: `convergence-${index}`,
      label: `Convergence ballot ${index + 1}`,
      sort: 10_000 + index,
    };
  return {
    key: `round-${index}`,
    label: `Group ballot ${index + 1}`,
    sort: index + 1,
  };
}
export function preferStageVote(existing, item) {
  if (!existing) return true;
  const missing = (vote) => vote.optionText === "Did Not Vote";
  if (missing(existing) !== missing(item)) return missing(existing);
  return (
    new Date(item.createdAt || 0).getTime() >=
    new Date(existing.createdAt || 0).getTime()
  );
}

export function buildQualitySankeyGraph({
  selectedRooms,
  showDidNotVote = true,
  showFinalDecision = false,
  showPersonalPhase = false,
}) {
  const normalizeOptionText = (text) => {
    const clean = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return "Did Not Vote";
    const lower = clean.toLowerCase();
    if (lower === "yes" || lower === "yes.") return "Yes";
    if (lower === "no" || lower === "no.") return "No";
    if (lower === "abstain" || lower === "abstained") return "Abstained";
    if (
      lower === "did not vote" ||
      lower === "didn’t vote" ||
      lower === "didnt vote"
    )
      return "Did Not Vote";
    return clean;
  };

  const optionKey = (text) => normalizeOptionText(text).toLowerCase();

  const getOptionColor = (text) => {
    const clean = String(text || "").toLowerCase();
    if (clean === "did not vote") return "#64748b";
    if (clean === "keep discussing") return "#94a3b8";
    if (clean === "yes") return "#10b981";
    if (clean === "no") return "#f43f5e";
    if (clean === "abstained" || clean === "abstain") return "#64748b";
    const colors = [
      "#06b6d4",
      "#10b981",
      "#f59e0b",
      "#6366f1",
      "#ec4899",
      "#14b8a6",
      "#f43f5e",
      "#3b82f6",
      "#84cc16",
      "#eab308",
    ];
    let hash = 0;
    for (let i = 0; i < clean.length; i += 1) {
      hash = clean.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const toRgba = (hex, alpha) => {
    const normalized = String(hex || "").replace("#", "");
    if (normalized.length !== 6) return `rgba(148, 163, 184, ${alpha})`;
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const stageMap = new Map();
  const userStageMap = new Map();

  const includePoll = (poll) => {
    if (!showPersonalPhase && poll?.isPersonalPhase) return false;
    if (!showFinalDecision && poll?.isFinalDecision) return false;
    return true;
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
    if (preferStageVote(existing, item))
      userRecord.stages.set(item.stageKey, item);
  };

  for (const room of selectedRooms) {
    const polls = Array.isArray(room?.polls) ? room.polls : [];
    const visiblePollEntries = polls
      .map((poll, index) => ({ poll, originalIndex: index }))
      .filter(({ poll }) => includePoll(poll));

    visiblePollEntries.forEach(({ poll }) => {
      const ballotIndex = polls
        .filter((p) => !p.isPersonalPhase && !p.isFinalDecision)
        .findIndex((p) => p.id === poll.id);
      rememberStage(stageForPoll(poll, ballotIndex, room.roomType));
    });

    for (const [rawUserId, user] of Object.entries(room?.userVotes || {})) {
      const userKey = String(rawUserId || user?.username || "unknown");
      for (const { poll, originalIndex } of visiblePollEntries) {
        const visibleIndex = polls
          .filter((p) => !p.isPersonalPhase && !p.isFinalDecision)
          .findIndex((p) => p.id === poll.id);
        const stage = stageForPoll(poll, visibleIndex, room.roomType);
        const optionText = normalizeOptionText(
          user?.votes?.[originalIndex]?.optionText,
        );
        if (poll?.isPersonalPhase && optionText === "Did Not Vote") continue;
        if (!showDidNotVote && optionText === "Did Not Vote") continue;
        rememberUserStage(userKey, {
          stageKey: stage.key,
          optionText,
          optionKey: optionKey(optionText),
          username: user?.username || "unknown user",
          createdAt: poll?.created_at || "",
        });
      }
    }
  }

  const stages = [...stageMap.values()].sort(
    (a, b) => a.sort - b.sort || a.label.localeCompare(b.label),
  );
  const stageIndex = new Map(stages.map((stage, index) => [stage.key, index]));
  const nodeMap = new Map();
  const linkMap = new Map();

  for (const userRecord of userStageMap.values()) {
    const sequence = [...userRecord.stages.values()]
      .filter((item) => stageIndex.has(item.stageKey))
      .map((item) => ({ ...item, step: stageIndex.get(item.stageKey) }))
      .sort((a, b) => a.step - b.step);

    for (const item of sequence) {
      const nodeId = `${item.step}::${item.optionKey}`;
      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId,
          label: item.optionText,
          step: item.step,
          voters: new Set(),
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
          targetLabel: sequence[index + 1].optionText,
        });
      }
      const link = linkMap.get(linkKey);
      link.value += 1;
      link.usernames.push(userRecord.username);
    }
  }

  const nodes = [...nodeMap.values()].sort(
    (a, b) =>
      a.step - b.step ||
      b.voters.size - a.voters.size ||
      a.label.localeCompare(b.label),
  );
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
    const position = Math.max(
      0,
      peers.findIndex((peer) => peer.id === node.id),
    );
    nodeX.push(
      maxStep === 0 ? 0.5 : Math.min(0.98, Math.max(0.02, node.step / maxStep)),
    );
    nodeY.push(
      peers.length <= 1
        ? 0.5
        : Math.min(0.95, Math.max(0.05, (position + 0.5) / peers.length)),
    );
  }

  const links = [...linkMap.values()].filter(
    (link) => nodeIndex.has(link.source) && nodeIndex.has(link.target),
  );
  const linkSources = links.map((link) => nodeIndex.get(link.source));
  const linkTargets = links.map((link) => nodeIndex.get(link.target));
  const linkValues = links.map((link) => link.value);
  const linkColors = links.map((link) =>
    toRgba(getOptionColor(link.sourceLabel), 0.38),
  );
  const linkHover = links.map((link) => {
    const users = link.usernames.join(", ");
    return `<b>${link.sourceLabel} -> ${link.targetLabel}</b><br>${link.value} user${link.value === 1 ? "" : "s"}<br>${users}`;
  });

  const nodeLabels = nodes.map((node) => node.label);
  const nodeColors = nodes.map((node) => getOptionColor(node.label));
  const nodeHover = nodes.map((node) => {
    const voters = [...node.voters].sort();
    return `<b>${node.label}</b><br>${voters.length} user${voters.length === 1 ? "" : "s"}<br>${voters.join(", ")}`;
  });

  return {
    empty: nodes.length === 0 || links.length === 0,
    stageLabels: stages.map((stage) => stage.label),
    nodeLabels,
    nodeColors,
    nodeHover,
    nodeX,
    nodeY,
    linkSources,
    linkTargets,
    linkValues,
    linkColors,
    linkHover,
  };
}
