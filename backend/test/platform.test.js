import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { io } from "socket.io-client";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "";
process.env.JWT_SECRET = "test-secret-which-is-longer-than-32-characters";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
process.env.MAX_RUN_WORKERS = "8";
process.env.ACCOUNT_RATE_LIMIT = "80";
const { createPlatform } = await import("../src/platform/server.js");

test(
  "accounts, isolated runs, admission, credentials, repeat and reconnect",
  { timeout: 120000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cime-platform-test-"),
    );
    let platform = await createPlatform({ dataDir: directory });
    await new Promise((resolve) =>
      platform.server.listen(0, "127.0.0.1", resolve),
    );
    let base = `http://127.0.0.1:${platform.server.address().port}`;
    const sockets = [];
    t.after(async () => {
      sockets.forEach((socket) => socket.disconnect());
      await platform.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    async function request(
      route,
      body,
      token,
      method = body === undefined ? "GET" : "POST",
      expected = 200,
    ) {
      const response = await fetch(`${base}/api${route}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => ({}));
      assert.equal(response.status, expected, JSON.stringify(data));
      return data;
    }
    async function account(email) {
      const registration = await request(
        "/accounts/register",
        {
          email,
          name: email.split("@")[0],
          password: "a-secure-test-password",
        },
        null,
        "POST",
        201,
      );
      const token = new URLSearchParams(
        new URL(registration.developmentActionUrl).hash.split("?")[1],
      ).get("token");
      await request(
        "/accounts/login",
        { email, password: "a-secure-test-password" },
        null,
        "POST",
        403,
      );
      await request("/accounts/verify", { token });
      await request("/accounts/verify", { token }, null, "POST", 400);
      return request("/accounts/login", {
        email,
        password: "a-secure-test-password",
      });
    }
    const first = await account("first@example.com");
    const second = await account("second@example.com");
    const runA = (
      await request(
        "/platform/decisions",
        { title: "Decision A" },
        first.token,
        "POST",
        201,
      )
    ).run;
    const runB = (
      await request(
        "/platform/decisions",
        { title: "Decision B" },
        second.token,
        "POST",
        201,
      )
    ).run;
    const config = {
      globalQuestion: "Should we improve the square?",
      decisionContext: "Discuss the town square.",
      deliberationQuestions: [
        {
          topic: "transport",
          question_text: "How should access work?",
          predefined_answers: ["Walking", "Driving"],
        },
      ],
    };
    await request(
      `/platform/runs/${runA.id}`,
      undefined,
      second.token,
      "GET",
      404,
    );
    for (const [run, owner] of [
      [runA, first],
      [runB, second],
    ]) {
      await request(
        `/platform/runs/${run.id}`,
        { config },
        owner.token,
        "PATCH",
      );
      await request(
        `/platform/runs/${run.id}/admission`,
        { open: true },
        owner.token,
      );
    }
    const inviteA = new URL(runA.invite_url).pathname.split("/").at(-1);
    const inviteB = new URL(runB.invite_url).pathname.split("/").at(-1);
    const [aliceA, aliceB] = await Promise.all([
      request(`/platform/invitations/${inviteA}/join`, { username: "Ålice" }),
      request(`/platform/invitations/${inviteB}/join`, { username: "Alice" }),
    ]);
    const duplicateJoin = await request(
      `/platform/invitations/${inviteA}/join`,
      { username: "ålice" },
      null,
      "POST",
      409,
    );
    assert.match(duplicateJoin.error, /username is already taken/i);
    await request(`/platform/invitations/${inviteA}/join`, { username: "Bob" });
    await request(
      `/platform/runs/${runA.id}`,
      { access_mode: "credentials" },
      first.token,
      "PATCH",
      409,
    );
    await request(
      `/platform/runs/${runB.id}/engine/rooms`,
      undefined,
      aliceA.token,
      "GET",
      401,
    );
    await request(
      `/platform/runs/${runA.id}/engine/admin/users`,
      undefined,
      aliceA.token,
      "GET",
      401,
    );
    await request(
      `/platform/runs/${runA.id}/engine/admin/db/tables`,
      undefined,
      first.token,
      "GET",
      403,
    );
    await Promise.all([
      request(`/platform/runs/${runA.id}/start`, {}, first.token),
      request(`/platform/runs/${runB.id}/start`, {}, second.token),
    ]);
    await request(
      `/platform/runs/${runA.id}/start`,
      {},
      first.token,
      "POST",
      409,
    );
    await request(
      `/platform/invitations/${inviteA}/join`,
      { username: "Late" },
      null,
      "POST",
      409,
    );
    const recovered = await request(`/platform/invitations/${inviteA}/join`, {
      recoveryCode: aliceA.recoveryCode,
    });
    assert.equal(recovered.user.id, aliceA.user.id);
    assert.equal(
      (await request(`/platform/runs/${runA.id}`, undefined, first.token))
        .participants.length,
      2,
    );
    assert.equal(
      (await request(`/platform/runs/${runB.id}`, undefined, second.token))
        .participants.length,
      1,
    );
    const roomsA = (
      await request(
        `/platform/runs/${runA.id}/engine/rooms`,
        undefined,
        aliceA.token,
      )
    ).rooms;
    const roomsB = (
      await request(
        `/platform/runs/${runB.id}/engine/rooms`,
        undefined,
        aliceB.token,
      )
    ).rooms;
    assert.equal(roomsA.length, 1);
    assert.equal(roomsB.length, 1);
    async function connect(participant, run) {
      const socket = io(base, {
        auth: { token: participant.token, runId: run.id },
        transports: ["websocket"],
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      return socket;
    }
    const socketA = await connect(aliceA, runA);
    const socketB = await connect(aliceB, runB);
    const once = (socket, name) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Missing socket event ${name}`)),
          5000,
        );
        socket.once(name, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
      });
    const joinedA = once(socketA, "joined_room");
    socketA.emit("join_room", { roomId: roomsA[0].id });
    await joinedA;
    const joinedB = once(socketB, "joined_room");
    socketB.emit("join_room", { roomId: roomsB[0].id });
    await joinedB;
    let leaked = false;
    socketB.on("receive_message", (message) => {
      if (message.text === "Only decision A") leaked = true;
    });
    const received = once(socketA, "receive_message");
    socketA.emit("send_message", {
      roomId: roomsA[0].id,
      text: "Only decision A",
    });
    assert.equal((await received).text, "Only decision A");
    const monitoring = await request(
      `/platform/runs/${runA.id}/engine/admin/monitoring`,
      undefined,
      first.token,
    );
    assert.equal(monitoring.personalSummary.total, 2);
    assert.equal(
      monitoring.personalSummary.inProgress +
        monitoring.personalSummary.completed +
        monitoring.personalSummary.inactive,
      2,
    );
    await request(
      `/platform/runs/${runA.id}/engine/admin/monitoring`,
      undefined,
      second.token,
      "GET",
      404,
    );
    // Exercise the unchanged polling routes behind the authenticated gateway.
    const createdPoll = await request(
      `/platform/runs/${runA.id}/engine/admin/rooms/${roomsA[0].id}/polls`,
      {
        question: "Choose a transport option",
        options: ["Walking", "Driving"],
      },
      first.token,
      "POST",
      201,
    );
    const ballot = (
      await request(
        `/platform/runs/${runA.id}/engine/rooms/${roomsA[0].id}/polls`,
        undefined,
        aliceA.token,
      )
    ).polls.find((poll) => poll.id === createdPoll.pollId);
    await request(
      `/platform/runs/${runA.id}/engine/rooms/polls/${createdPoll.pollId}/vote`,
      { optionId: ballot.options[0].id },
      first.token,
      "POST",
      403,
    );
    await request(
      `/platform/runs/${runA.id}/engine/rooms/polls/${createdPoll.pollId}/vote`,
      { optionId: ballot.options[0].id },
      aliceA.token,
    );
    const voted = (
      await request(
        `/platform/runs/${runA.id}/engine/rooms/${roomsA[0].id}/polls`,
        undefined,
        aliceA.token,
      )
    ).polls.find((poll) => poll.id === createdPoll.pollId);
    assert.equal(voted.has_voted, true);
    assert.equal(voted.my_vote_option_id, ballot.options[0].id);
    const exportedA = await request(
      `/platform/runs/${runA.id}/engine/admin/decision-process/export`,
      undefined,
      first.token,
    );
    const exportedB = await request(
      `/platform/runs/${runB.id}/engine/admin/decision-process/export`,
      undefined,
      second.token,
    );
    assert.ok(JSON.stringify(exportedA).includes("Only decision A"));
    assert.ok(!JSON.stringify(exportedB).includes("Only decision A"));
    assert.equal(leaked, false);
    await request(
      `/platform/runs/${runA.id}/stop`,
      {},
      second.token,
      "POST",
      404,
    );
    await request(
      `/platform/runs/${runA.id}/archive`,
      {},
      first.token,
      "POST",
      409,
    );
    const stopped = await request(
      `/platform/runs/${runA.id}/stop`,
      {},
      first.token,
    );
    assert.equal(stopped.run.status, "interrupted");
    assert.equal(stopped.run.admission_open, false);
    assert.equal(
      (
        await platform.manager.call(
          await platform.store
            .query("SELECT * FROM runs WHERE id = ?", [runA.id])
            .then((rows) => rows[0]),
          "/state",
        )
      ).phase,
      "idle",
    );
    await request(
      `/platform/runs/${runA.id}/engine/rooms/polls/${createdPoll.pollId}/vote`,
      { optionId: ballot.options[0].id },
      aliceA.token,
      "POST",
      409,
    );
    const archived = await request(
      `/platform/runs/${runA.id}/archive`,
      {},
      first.token,
    );
    assert.equal(archived.run.archived, true);
    assert.ok(
      (await request("/platform/decisions", undefined, first.token)).runs.find(
        (run) => run.id === runA.id,
      ).archived,
    );
    const restored = await request(
      `/platform/runs/${runA.id}/archive`,
      { archived: false },
      first.token,
    );
    assert.equal(restored.run.archived, false);
    assert.equal(restored.run.status, "interrupted");
    assert.equal(
      (
        await request(
          `/platform/participants/${runB.id}`,
          undefined,
          aliceB.token,
        )
      ).phase,
      "gathering",
    );
    const repeated = (
      await request(
        `/platform/runs/${runA.id}/repeat`,
        {},
        first.token,
        "POST",
        201,
      )
    ).run;
    assert.notEqual(repeated.id, runA.id);
    await request(
      `/platform/runs/${repeated.id}`,
      { title: "Other owner" },
      second.token,
      "PATCH",
      404,
    );
    await request(
      `/platform/runs/${repeated.id}`,
      { title: " " },
      first.token,
      "PATCH",
      400,
    );
    await request(
      `/platform/runs/${repeated.id}`,
      { description: "x".repeat(2001) },
      first.token,
      "PATCH",
      400,
    );
    const edited = await request(
      `/platform/runs/${repeated.id}`,
      {
        title: "Dinner draft",
        description: "Choose our team dinner location.",
      },
      first.token,
      "PATCH",
    );
    assert.equal(edited.run.title, "Dinner draft");
    assert.equal(edited.run.description, "Choose our team dinner location.");
    assert.equal(
      (await request(`/platform/runs/${runA.id}`, undefined, first.token)).run
        .title,
      "Decision A",
    );
    const publicDraft = await request(
      `/platform/invitations/${new URL(repeated.invite_url).pathname.split("/").at(-1)}`,
    );
    assert.equal(publicDraft.title, "Dinner draft");
    assert.equal(publicDraft.description, edited.run.description);
    await request(
      `/platform/runs/${runA.id}`,
      { title: "Change stopped run" },
      first.token,
      "PATCH",
      409,
    );
    const disposable = (
      await request(
        `/platform/runs/${repeated.id}/repeat`,
        {},
        first.token,
        "POST",
        201,
      )
    ).run;
    assert.equal(disposable.title, edited.run.title);
    assert.equal(disposable.description, edited.run.description);
    await request(
      `/platform/runs/${disposable.id}`,
      undefined,
      second.token,
      "DELETE",
      404,
    );
    await request(
      `/platform/runs/${disposable.id}`,
      undefined,
      first.token,
      "DELETE",
      409,
    );
    await request(`/platform/runs/${disposable.id}`, undefined, first.token);
    await request(`/platform/runs/${disposable.id}/archive`, {}, first.token);
    await request(
      `/platform/runs/${disposable.id}`,
      { title: "Archived draft" },
      first.token,
      "PATCH",
      409,
    );
    await request(
      `/platform/runs/${disposable.id}`,
      undefined,
      first.token,
      "DELETE",
    );
    await assert.rejects(
      fs.access(path.join(directory, "runs", disposable.id)),
      { code: "ENOENT" },
    );
    await request(
      `/platform/runs/${disposable.id}`,
      undefined,
      first.token,
      "GET",
      404,
    );
    await request(
      `/platform/runs/${disposable.id}/engine/admin/rooms`,
      undefined,
      first.token,
      "GET",
      404,
    );
    await request(
      `/platform/invitations/${new URL(disposable.invite_url).pathname.split("/").at(-1)}`,
      undefined,
      null,
      "GET",
      404,
    );
    assert.ok(
      !(await request("/platform/decisions", undefined, first.token)).runs.some(
        (run) => run.id === disposable.id,
      ),
    );
    assert.equal(
      (await request(`/platform/runs/${repeated.id}`, undefined, first.token))
        .run.title,
      "Dinner draft",
    );
    const onlyRun = (
      await request(
        "/platform/decisions",
        { title: "Temporary decision" },
        first.token,
        "POST",
        201,
      )
    ).run;
    await request(`/platform/runs/${onlyRun.id}/archive`, {}, first.token);
    await request(
      `/platform/runs/${onlyRun.id}`,
      undefined,
      first.token,
      "DELETE",
    );
    assert.deepEqual(
      await platform.store.query("SELECT id FROM decisions WHERE id = ?", [
        onlyRun.decision_id,
      ]),
      [],
    );

    assert.deepEqual(
      (await request(`/platform/runs/${repeated.id}`, undefined, first.token))
        .participants,
      [],
    );
    assert.ok(
      JSON.stringify(
        await request(
          `/platform/runs/${runA.id}/engine/admin/decision-process/export`,
          undefined,
          first.token,
        ),
      ).includes("Only decision A"),
    );
    await request(
      `/platform/runs/${repeated.id}`,
      { access_mode: "credentials" },
      first.token,
      "PATCH",
    );
    const credentials = await request(
      `/platform/runs/${repeated.id}/credentials`,
      { entries: [{ username: "Assigned" }] },
      first.token,
    );
    const inviteC = new URL(repeated.invite_url).pathname.split("/").at(-1);
    await request(
      `/platform/runs/${repeated.id}/admission`,
      { open: true },
      first.token,
    );
    await request(
      `/platform/runs/${repeated.id}`,
      { description: "Recruiting edit" },
      first.token,
      "PATCH",
      409,
    );
    await request(
      `/platform/invitations/${inviteC}/join`,
      { username: "Assigned", password: "wrong" },
      null,
      "POST",
      401,
    );
    const assigned = await request(
      `/platform/invitations/${inviteC}/join`,
      credentials.credentials[0],
    );
    await request(
      `/platform/runs/${repeated.id}/admission`,
      { open: false },
      first.token,
    );
    const assignedAgain = await request(
      `/platform/invitations/${inviteC}/join`,
      credentials.credentials[0],
    );
    assert.equal(assignedAgain.user.id, assigned.user.id);
    await request(
      `/platform/runs/${repeated.id}/rotate-invitation`,
      {},
      first.token,
    );
    await request(
      `/platform/invitations/${inviteC}`,
      undefined,
      null,
      "GET",
      404,
    );
    const qr = await fetch(`${base}/api/platform/runs/${repeated.id}/qr`, {
      headers: { Authorization: `Bearer ${first.token}` },
    });
    assert.equal(qr.status, 200);
    assert.match(await qr.text(), /<svg/);
    await request(`/platform/participants/${runA.id}/logout`, {}, aliceA.token);
    await request(
      `/platform/participants/${runA.id}`,
      undefined,
      aliceA.token,
      "GET",
      401,
    );
    assert.equal(socketA.connected, false);
    const reset = await request("/accounts/forgot-password", {
      email: first.user.email,
    });
    const resetToken = new URLSearchParams(
      new URL(reset.developmentActionUrl).hash.split("?")[1],
    ).get("token");
    await request("/accounts/reset-password", {
      token: resetToken,
      password: "changed-secure-password",
    });
    await request("/accounts/me", undefined, first.token, "GET", 401);
    await request(
      "/accounts/reset-password",
      { token: resetToken, password: "changed-secure-password" },
      null,
      "POST",
      400,
    );
    await request("/accounts/login", {
      email: first.user.email,
      password: "changed-secure-password",
    });
    await platform.close();
    platform = await createPlatform({ dataDir: directory });
    await new Promise((resolve) =>
      platform.server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${platform.server.address().port}`;
    assert.equal(
      (
        await request(
          `/platform/participants/${runB.id}`,
          undefined,
          aliceB.token,
        )
      ).phase,
      "gathering",
    );
    assert.equal(
      (await request(`/platform/runs/${runB.id}`, undefined, second.token))
        .participants.length,
      1,
    );
    await request(
      `/platform/runs/${runB.id}/engine/admin/simulation/stop`,
      {},
      second.token,
    );
    assert.equal(
      (await request(`/platform/runs/${runB.id}`, undefined, second.token)).run
        .status,
      "interrupted",
      "simulation stop also updates the platform run status",
    );
    const stoppedAndArchived = await request(
      `/platform/runs/${runB.id}/stop`,
      { archived: true },
      second.token,
    );
    assert.equal(stoppedAndArchived.run.status, "interrupted");
    assert.equal(stoppedAndArchived.run.archived, true);
    assert.equal(stoppedAndArchived.run.admission_open, false);
    assert.equal(
      (await request(`/platform/runs/${runB.id}`, undefined, second.token))
        .participants.length,
      1,
    );
    await request(
      `/platform/runs/${runB.id}/stop`,
      { archived: true },
      second.token,
    );
    assert.ok(
      JSON.stringify(
        await request(
          `/platform/runs/${runB.id}/engine/admin/decision-process/export`,
          undefined,
          second.token,
        ),
      ).includes("transport"),
    );
  },
);
