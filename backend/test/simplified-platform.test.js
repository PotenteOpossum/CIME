import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import Database from "better-sqlite3";
import { io } from "socket.io-client";

process.env.JWT_SECRET =
  "simplified-platform-test-secret-at-least-32-characters";
process.env.DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
const { createPlatform } = await import("../src/platform/server.js");
test(
  "Simplified type, topic timers, restart recovery, final ballot, survey pipeline, and repeat persist across the platform",
  { timeout: 120000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cime-simplified-platform-"),
    );
    const platform = await createPlatform({ dataDir: directory });
    await new Promise((resolve) =>
      platform.server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${platform.server.address().port}`;
    t.after(async () => {
      await platform.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    async function request(
      route,
      {
        body,
        token,
        method = body === undefined ? "GET" : "POST",
        status = 200,
      } = {},
    ) {
      const response = await fetch(origin + "/api" + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    }
    const credentials = {
      email: "simple@example.com",
      name: "Researcher",
      password: "secure-test-password-only",
    };
    const registration = await request("/accounts/register", {
      body: credentials,
      status: 201,
    });
    const verification = new URLSearchParams(
      new URL(registration.developmentActionUrl).hash.split("?")[1],
    ).get("token");
    await request("/accounts/verify", { body: { token: verification } });
    const owner = await request("/accounts/login", { body: credentials });
    await request("/platform/decisions", {
      token: owner.token,
      body: { title: "Bad type", discussion_type: "unknown" },
      status: 400,
    });
    const full = (
      await request("/platform/decisions", {
        token: owner.token,
        body: { title: "Full" },
        status: 201,
      })
    ).run;
    assert.equal(full.discussion_type, "full");
    const run = (
      await request("/platform/decisions", {
        token: owner.token,
        body: { title: "Simplified", discussion_type: "simplified" },
        status: 201,
      })
    ).run;
    assert.equal(run.discussion_type, "simplified");
    const engine = `/platform/runs/${run.id}/engine`;
    const initialAdvanced = await request(
      `${engine}/admin/simplified/settings`,
      { token: owner.token },
    );
    assert.deepEqual(Object.keys(initialAdvanced.settings).sort(), [
      "facilitatorPrompt",
      "finalVoteMinutes",
      "interventionCooldownSeconds",
      "interventionEnabled",
      "interventionMaxPerTopic",
      "model",
      "quietMinutes",
    ]);
    await request(
      `/platform/runs/${full.id}/engine/admin/simplified/settings`,
      { token: owner.token, status: 404 },
    );
    const fullAdvanced = await request(
      `/platform/runs/${full.id}/engine/admin/decision-process/settings`,
      { token: owner.token },
    );
    assert.ok("consensus_sensitivity" in fullAdvanced.settings);
    for (const [method, route] of [
      ["GET", "/admin/decision-process/settings"],
      ["GET", "/admin/llm-models"],
      ["GET", "/admin/simulation"],
      ["POST", "/admin/decision-process/showdown"],
      ["POST", "/admin/simulation/start"],
      ["POST", "/admin/rooms"],
      ["PUT", "/admin/rooms/1/members"],
    ]) {
      await request(engine + route, {
        token: owner.token,
        method,
        ...(method === "GET" ? {} : { body: {} }),
        status: 409,
      });
    }
    const advanced = {
      ...initialAdvanced.settings,
      finalVoteMinutes: 2,
      quietMinutes: 0,
      facilitatorPrompt:
        "Facilitate neutrally. Ask concise questions and invite different perspectives.",
    };
    await request(`${engine}/admin/simplified/settings`, {
      token: owner.token,
      method: "PUT",
      body: { ...advanced, clustering_strategy: "random" },
      status: 400,
    });
    await request(`${engine}/admin/simplified/settings`, {
      token: owner.token,
      method: "PUT",
      body: advanced,
    });
    const draftExport = await request(
      `${engine}/admin/decision-process/export`,
      { token: owner.token },
    );
    assert.equal(draftExport.configuration.discussionType, "simplified");
    assert.deepEqual(draftExport.configuration.simplifiedSettings, advanced);
    await request(`/platform/runs/${run.id}`, {
      token: owner.token,
      method: "PATCH",
      body: { config: { settings: { consensus_sensitivity: 1 } } },
      status: 400,
    });
    await request(`/platform/runs/${run.id}`, {
      token: owner.token,
      method: "PATCH",
      body: { config: { discussionType: "full" } },
      status: 409,
    });
    const config = {
      globalQuestion: "Improve the square?",
      decisionContext: "Study scenario",
      generalDescription: "Welcome everyone.",
      deliberationQuestions: [
        {
          topic: "Trees",
          question_text: "Where should trees go?",
          predefined_answers: ["Edges", "Seating"],
          durationMinutes: 10,
        },
        {
          topic: "Access",
          question_text: "How should deliveries work?",
          predefined_answers: ["Keep access", "Timed access"],
          durationMinutes: 20,
        },
      ],
    };
    await request(`/platform/runs/${run.id}`, {
      token: owner.token,
      method: "PATCH",
      body: { config },
    });
    const survey = (stage) => ({
      enabled: true,
      title: stage,
      description: "",
      questions: [
        {
          id: "support",
          type: "single_choice",
          label: "Support?",
          required: false,
          options: ["Yes", "No"],
        },
      ],
    });
    await request(`${engine}/admin/surveys`, {
      token: owner.token,
      method: "PUT",
      body: { pre: survey("pre"), post: survey("post") },
    });
    await request(`/platform/runs/${run.id}/admission`, {
      token: owner.token,
      body: { open: true },
    });
    const invite = run.invite_url.split("/").at(-1);
    const alice = await request(`/platform/invitations/${invite}/join`, {
      body: { username: "Alice" },
    });
    const bob = await request(`/platform/invitations/${invite}/join`, {
      body: { username: "Bob" },
    });
    for (const participant of [alice, bob])
      await request(`${engine}/surveys/pre/responses`, {
        token: participant.token,
        body: { answers: { support: "Yes" } },
        status: 201,
      });
    await request(`/platform/runs/${run.id}/start`, {
      token: owner.token,
      body: { config: { discussionType: "full" } },
      status: 409,
    });
    await request(`/platform/runs/${run.id}/start`, {
      token: owner.token,
      body: {},
    });
    await request(`${engine}/admin/simplified/settings`, {
      token: owner.token,
      method: "PUT",
      body: advanced,
      status: 409,
    });
    const publicStatus = await request(`${engine}/decision`, {
      token: alice.token,
    });
    assert.equal(publicStatus.clustering, null);
    assert.deepEqual(
      publicStatus.agents.map((agent) => agent.key),
      ["facilitator", "schedule"],
    );
    const processReply = await request(`${engine}/decision/agent-chat`, {
      token: alice.token,
      body: { message: "What is happening?" },
    });
    assert.match(processReply.reply, /shared discussion/);
    assert.doesNotMatch(processReply.reply, /Phase 1 progress/);
    const advancedStatus = await request(
      `${engine}/admin/simplified/overview`,
      { token: owner.token },
    );
    assert.equal(advancedStatus.topic.topic, "Trees");
    assert.equal(advancedStatus.participants.length, 2);
    const rooms = (await request(`${engine}/rooms`, { token: alice.token }))
      .rooms;
    assert.equal(rooms.length, 1);
    const room = rooms[0];
    assert.equal(room.room_type, "plenary");
    let roomState = (
      await request(`${engine}/rooms/${room.id}/status`, { token: alice.token })
    ).status;
    assert.equal(roomState.topic_number, 1);
    assert.deepEqual(roomState.options, ["Edges", "Seating"]);
    await request(`${engine}/admin/rooms/${room.id}/polls`, {
      token: owner.token,
      body: { question: "Premature topic vote", options: ["A", "B"] },
      status: 409,
    });
    const socket = io(origin, {
      auth: { token: alice.token, runId: run.id },
      transports: ["websocket"],
    });
    t.after(() => socket.disconnect());
    await once(socket, "connect");
    const joined = once(socket, "joined_room");
    socket.emit("join_room", { roomId: room.id });
    await joined;
    const received = once(socket, "receive_message");
    socket.emit("send_message", {
      roomId: room.id,
      text: "@bot can we vote on this topic now?",
    });
    await received;
    assert.equal(
      (
        await request(`${engine}/rooms/${room.id}/polls`, {
          token: alice.token,
        })
      ).polls.length,
      0,
    );
    const runDb = new Database(path.join(directory, "runs", run.id, "chat.db"));
    t.after(() => runDb.close());
    runDb
      .prepare(
        "UPDATE simplified_cime SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = 1",
      )
      .run();
    roomState = (
      await request(`${engine}/rooms/${room.id}/status`, { token: alice.token })
    ).status;
    assert.equal(roomState.topic_number, 2);
    const savedDeadline = roomState.deadline_at;
    const worker = platform.manager.workers.get(run.id);
    worker.stopping = true;
    platform.manager.workers.delete(run.id);
    const exited = once(worker.child, "exit");
    worker.child.kill("SIGTERM");
    await exited;
    roomState = (
      await request(`${engine}/rooms/${room.id}/status`, { token: alice.token })
    ).status;
    assert.equal(roomState.topic_number, 2);
    assert.equal(roomState.deadline_at, savedDeadline);
    assert.equal(runDb.prepare("SELECT COUNT(*) AS n FROM polls").get().n, 0);
    runDb
      .prepare(
        "UPDATE simplified_cime SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = 1",
      )
      .run();
    roomState = (
      await request(`${engine}/rooms/${room.id}/status`, { token: alice.token })
    ).status;
    assert.equal(roomState.stage, "final_vote");
    const polls = (
      await request(`${engine}/rooms/${room.id}/polls`, { token: alice.token })
    ).polls;
    assert.equal(polls.length, 1);
    assert.equal(polls[0].question, config.globalQuestion);
    for (const participant of [alice, bob])
      await request(`${engine}/rooms/polls/${polls[0].id}/vote`, {
        token: participant.token,
        body: { optionId: polls[0].options[0].id },
      });
    const completed = await request(`/platform/runs/${run.id}`, {
      token: owner.token,
    });
    assert.equal(completed.run.status, "completed");
    assert.equal(
      (
        await request(`/platform/participants/${run.id}`, {
          token: alice.token,
        })
      ).surveys.pending.stage,
      "post",
    );
    await request(`${engine}/surveys/post/responses`, {
      token: alice.token,
      body: { answers: { support: "Yes" } },
      status: 201,
    });
    assert.equal(
      (
        await request(`/platform/participants/${run.id}`, {
          token: alice.token,
        })
      ).surveys.pending,
      null,
    );
    const repeated = (
      await request(`/platform/runs/${run.id}/repeat`, {
        token: owner.token,
        body: {},
        status: 201,
      })
    ).run;
    const repeatedSettings = await request(
      `/platform/runs/${repeated.id}/engine/admin/simplified/settings`,
      { token: owner.token },
    );
    assert.deepEqual(repeatedSettings.settings, advanced);
    assert.equal(repeatedSettings.locked, false);
    assert.equal(repeated.discussion_type, "simplified");
    assert.equal(repeated.config.deliberationQuestions[1].durationMinutes, 20);
    assert.equal(
      (await request(`/platform/runs/${repeated.id}`, { token: owner.token }))
        .participants.length,
      0,
    );
  },
);
