import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import {
  stageForPoll,
  buildQualitySankeyGraph,
  preferStageVote,
} from "../../admin-frontend/src/utils/qualitySankey.js";
process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "quality-test-secret-longer-than-32-characters";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-quality-"));
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.CIME_CONFIG_DIR = path.join(directory, "config");
await fs.cp(
  new URL("../agent-config", import.meta.url),
  process.env.CIME_CONFIG_DIR,
  { recursive: true },
);
const { db, initDb } = await import("../src/config/db.js");
initDb();
const { default: router } = await import("../src/routes/admin.js");
const app = express();
app.use("/admin", router);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const root = `http://127.0.0.1:${server.address().port}`;
const stamp = "2026-10-01T10:00:00.000Z";
const user = (name, admin = 0) =>
  Number(
    db
      .prepare(
        "INSERT INTO users(username, password_hash, is_admin) VALUES (?, ?, ?)",
      )
      .run(name, "test", admin).lastInsertRowid,
  );
const admin = user("admin", 1),
  alice = user("alice"),
  bob = user("bob"),
  swipeOnly = user("swipe-only");
const token = jwt.sign({ id: admin }, process.env.JWT_SECRET);
const group = Number(
  db
    .prepare("INSERT INTO rooms(name, room_type) VALUES ('group', 'group')")
    .run().lastInsertRowid,
);
const convergence = Number(
  db
    .prepare(
      "INSERT INTO rooms(name, room_type) VALUES ('convergence', 'convergence')",
    )
    .run().lastInsertRowid,
);
for (const [topic, order] of [
  ["budget", 1],
  ["venue", 2],
])
  db.prepare(
    "INSERT INTO gathering_questions(topic, question_text, question_order, created_at) VALUES (?, ?, ?, ?)",
  ).run(topic, topic, order, stamp);
db.prepare(
  "INSERT INTO messages(room_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?)",
).run(
  group,
  alice,
  "I suggest a cheaper venue because everyone should be able to join.",
  stamp,
);
function poll(type, topic, time, room = group, consensus = 1) {
  const id = Number(
    db
      .prepare(
        "INSERT INTO polls(room_id, question, suggestion, poll_type, created_at, is_closed, has_consensus) VALUES (?, ?, ?, ?, ?, 1, ?)",
      )
      .run(room, topic, topic, type, time, consensus).lastInsertRowid,
  );
  const ids = ["A", "B", "Other"].map((text) =>
    Number(
      db
        .prepare("INSERT INTO poll_options(poll_id, option_text) VALUES (?, ?)")
        .run(id, text).lastInsertRowid,
    ),
  );
  return { id, ids };
}
const swipe = poll("swipe", "budget", stamp, group, 1);
for (const [i, direction] of [
  [0, "left"],
  [1, "right"],
  [2, "left"],
])
  db.prepare(
    "INSERT INTO swipe_votes(poll_id, option_id, user_id, swipe_direction, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(swipe.id, swipe.ids[i], swipeOnly, direction, stamp);
const rank = poll("ranking", "budget", "2026-10-01T10:01:00.000Z");
for (const who of [alice, bob])
  for (const [i, option] of rank.ids.entries())
    db.prepare(
      "INSERT INTO poll_votes(poll_id, option_id, user_id, rank, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(rank.id, option, who, i + 1, stamp);
const other = poll("plurality", "venue", "2026-10-01T10:02:00.000Z");
for (const [who, custom] of [
  [alice, "My own venue"],
  [bob, null],
])
  db.prepare(
    "INSERT INTO poll_votes(poll_id, option_id, user_id, rank, custom_option_text, created_at) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(other.id, other.ids[2], who, custom, stamp);
const conv = poll(
  "plurality",
  "budget",
  "2026-10-01T10:03:00.000Z",
  convergence,
);
db.prepare(
  "INSERT INTO poll_votes(poll_id, option_id, user_id, rank, created_at) VALUES (?, ?, ?, 1, ?)",
).run(conv.id, conv.ids[0], alice, stamp);
async function stats(query = "") {
  const res = await fetch(`${root}/admin/decision-process/statistics${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}
test("quality statistics are cache-only by default, accurate for known ballots, and keep Sankey evidence", async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const result = await stats();
  for (const bin of result.timeSeries) {
    assert.ok(
      bin.passedPollsRatio >= 0 && bin.passedPollsRatio <= 1,
      "consensus rate is bounded even with successful swipe preselection",
    );
    assert.ok(bin.pollsPassed <= bin.pollsResolved);
  }
  assert.equal(result.analysisStatus.deliberative, false);
  assert.equal(
    result.summary.globalGiniCoefficient,
    0.6667,
    "one speaker among three participants has Gini 2/3",
  );
  assert.equal(
    result.summary.passedPollsRatio,
    1,
    "all decision ballots reach consensus",
  );
  assert.ok(
    Math.abs(
      Object.values(result.summary.deliberativeQuality.weights).reduce(
        (sum, weight) => sum + weight,
        0,
      ) - 1,
    ) < 1e-9,
    "composite weights are normalized",
  );
  assert.equal(result.analysisStatus.proactiveness, false);
  assert.equal(result.analysisStatus.options, false);
  for (const table of [
    "message_deliberative_quality_analyses",
    "message_proactiveness_analyses",
    "custom_option_analyses",
  ])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(
    result.polls.find((p) => p.id === rank.id).entropy,
    0,
    "identical first choices have zero entropy",
  );
  assert.equal(
    result.summary.totalResolvedPolls,
    3,
    "swipe preselection is not a consensus attempt",
  );
  assert.equal(
    result.summary.topicsPassedFirstTry,
    3,
    "first decision ballot, not swipe, determines first-try success",
  );
  assert.equal(
    result.sankeyData.budget[group].userVotes[swipeOnly].votes[1].optionText,
    "B",
  );
  const venue = result.sankeyData.venue[group];
  assert.equal(venue.userVotes[alice].votes[1].optionText, "My own venue");
  assert.equal(
    venue.userVotes[bob].votes[1].optionText,
    "Other",
    "never borrow another participant custom option",
  );
  const filtered = await stats("?topic=venue");
  assert.equal(filtered.analysisCounts.deliberative, 0);
  assert.equal(
    filtered.summary.deliberativeQuality.score,
    null,
    "no eligible messages is missing data, not a zero quality score",
  );
  assert.equal(
    filtered.summary.totalMessages,
    0,
    "budget messages are excluded from venue selection",
  );
  assert.equal(
    filtered.sankeyData.budget[group].userVotes[swipeOnly].votes[1].optionText,
    "B",
    "Sankey evidence is not erased by metric filters",
  );
  const unavailable = await fetch(
    `${root}/admin/decision-process/statistics?compute=proactiveness`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(
    unavailable.status,
    400,
    "unavailable AI is not reported as a neutral/zero score",
  );
  const { classifyHumanMessageProactiveness } =
    await import("../src/services/customOptionAnalysisService.js");
  const args = {
    messageId: 1,
    userId: alice,
    roomId: group,
    messageText: "cache identity fixture",
  };
  assert.equal(
    await classifyHumanMessageProactiveness({ ...args, allowCompute: false }),
    null,
  );
  const saved = await classifyHumanMessageProactiveness({
    ...args,
    allowCompute: true,
  });
  assert.equal(
    await classifyHumanMessageProactiveness({ ...args, allowCompute: false }),
    null,
    "failed neutral fallback is not a computed metric",
  );
  const row = db
    .prepare(
      "SELECT analysis_json FROM message_proactiveness_analyses WHERE message_id = 1",
    )
    .get();
  const completed = { ...JSON.parse(row.analysis_json), confidence: 0.8 };
  db.prepare(
    "UPDATE message_proactiveness_analyses SET analysis_json = ? WHERE message_id = 1",
  ).run(JSON.stringify(completed));
  assert.equal(
    (await classifyHumanMessageProactiveness({ ...args, allowCompute: false }))
      .confidence,
    0.8,
    "compute permission must not change cache identity",
  );
});
test("Sankey phases remain chronological and missing records cannot erase observed votes", () => {
  assert.ok(
    stageForPoll({}, 5, "group").sort < stageForPoll({}, 0, "convergence").sort,
  );
  assert.equal(stageForPoll({}, 0, "convergence").key, "convergence-0");
  const observed = { optionText: "A", createdAt: stamp };
  const missing = {
    optionText: "Did Not Vote",
    createdAt: "2026-10-01T12:00:00Z",
  };
  assert.equal(preferStageVote(observed, missing), false);
  assert.equal(preferStageVote(missing, observed), true);
});

test("Sankey links count each participant once across rooms and preserve phase ordering", () => {
  const rooms = [
    {
      roomType: "group",
      polls: [
        { id: "personal-a", isPersonalPhase: true },
        { id: 1 },
        { id: 2 },
      ],
      userVotes: {
        1: {
          username: "alice",
          votes: [
            { optionText: "A" },
            { optionText: "A" },
            { optionText: "B" },
          ],
        },
        2: {
          username: "bob",
          votes: [
            { optionText: "B" },
            { optionText: "B" },
            { optionText: "B" },
          ],
        },
      },
    },
    {
      roomType: "group",
      polls: [
        { id: "personal-b", isPersonalPhase: true },
        { id: 3 },
        { id: 4 },
      ],
      userVotes: {
        1: {
          username: "alice",
          votes: [
            { optionText: "Did Not Vote" },
            { optionText: "Did Not Vote" },
            { optionText: "Did Not Vote" },
          ],
        },
      },
    },
    {
      roomType: "convergence",
      polls: [{ id: 5 }],
      userVotes: {
        1: { username: "alice", votes: [{ optionText: "B" }] },
        2: { username: "bob", votes: [{ optionText: "B" }] },
      },
    },
  ];
  const graph = buildQualitySankeyGraph({ selectedRooms: rooms });
  assert.deepEqual(graph.stageLabels, [
    "Group ballot 1",
    "Group ballot 2",
    "Convergence ballot 1",
  ]);
  assert.equal(
    graph.linkValues.reduce((a, b) => a + b, 0),
    4,
    "two users each traverse two transitions",
  );
  for (let i = 0; i < graph.linkValues.length; i++) {
    assert.ok(graph.linkSources[i] < graph.nodeLabels.length);
    assert.ok(graph.linkTargets[i] < graph.nodeLabels.length);
    assert.ok(
      graph.nodeX[graph.linkSources[i]] < graph.nodeX[graph.linkTargets[i]],
      "no backward phase links",
    );
  }
  const withPersonal = buildQualitySankeyGraph({
    selectedRooms: rooms,
    showPersonalPhase: true,
  });
  assert.equal(withPersonal.stageLabels[0], "Personal");
  assert.equal(
    withPersonal.linkValues.reduce((a, b) => a + b, 0),
    6,
  );
});
