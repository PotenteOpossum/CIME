import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { once } from "node:events";

process.env.DATABASE_URL = "";
process.env.CIME_PGLITE_TEST_DIR = "";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET =
  "introduction-platform-test-secret-at-least-32-characters";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
const { createPlatform } = await import("../src/platform/server.js");
const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test(
  "description → pre-survey → CIME → post-survey is enforced, persists on reconnect, and copies only content on repeat",
  { timeout: 120000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cime-introduction-"),
    );
    const platform = await createPlatform({ dataDir: directory });
    await new Promise((resolve) =>
      platform.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${platform.server.address().port}/api`;
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
      const response = await fetch(base + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    }
    async function account(email) {
      const body = {
        email,
        name: "Researcher",
        password: "secure-test-password-only",
      };
      const registration = await request("/accounts/register", {
        body,
        status: 201,
      });
      const token = new URLSearchParams(
        new URL(registration.developmentActionUrl).hash.split("?")[1],
      ).get("token");
      await request("/accounts/verify", { body: { token } });
      return request("/accounts/login", { body });
    }
    const owner = await account("intro@example.com");
    const outsider = await account("outsider@example.com");
    const run = (
      await request("/platform/decisions", {
        token: owner.token,
        body: { title: "Heimplatz" },
        status: 201,
      })
    ).run;
    const engine = `/platform/runs/${run.id}/engine`;
    assert.equal(
      (await request(`${engine}/admin/introduction`, { token: owner.token }))
        .introduction.enabled,
      false,
    );
    await request(`${engine}/admin/introduction`, {
      token: outsider.token,
      status: 404,
    });
    await request(`${engine}/admin/introduction`, { status: 401 });
    const document = {
      enabled: true,
      title: "A greener Heimplatz",
      blocks: [
        {
          id: "context",
          type: "paragraph",
          text: "Read the proposal before answering.",
        },
        {
          id: "map",
          type: "image",
          src: pixel,
          alt: "Map of the square",
          caption: "Proposal area",
          width: 100,
        },
      ],
    };
    await request(`${engine}/admin/introduction`, {
      token: owner.token,
      method: "PUT",
      body: document,
    });
    await request(`${engine}/admin/introduction`, {
      token: owner.token,
      method: "PUT",
      body: {
        ...document,
        blocks: [
          {
            id: "bad",
            type: "image",
            src: "https://tracker.invalid/p.png",
            alt: "Tracking",
            caption: "",
          },
        ],
      },
      status: 400,
    });
    // A legitimate-sized image document must pass both gateway and engine body parsers.
    const largeBytes = Buffer.alloc(300000);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(largeBytes);
    const largeDocument = {
      ...document,
      blocks: [
        document.blocks[0],
        {
          ...document.blocks[1],
          src: `data:image/png;base64,${largeBytes.toString("base64")}`,
        },
      ],
    };
    await request(`${engine}/admin/introduction`, {
      token: owner.token,
      method: "PUT",
      body: largeDocument,
    });
    await request(`${engine}/admin/introduction`, {
      token: owner.token,
      method: "PUT",
      body: document,
    });
    const config = {
      globalQuestion: "Renovate the square?",
      decisionContext: "Public space",
      deliberationQuestions: [
        {
          topic: "Trees",
          question_text: "More trees?",
          predefined_answers: ["Yes", "No"],
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
      title: `${stage} survey`,
      description: "",
      questions: [
        {
          id: "support",
          type: "single_choice",
          label: "Support the proposal?",
          required: true,
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
    let alice = await request(`/platform/invitations/${invite}/join`, {
      body: { username: "Alice" },
    });
    const bob = await request(`/platform/invitations/${invite}/join`, {
      body: { username: "Bob" },
    });
    await request(`${engine}/admin/introduction`, {
      token: alice.token,
      status: 401,
    });
    const participant = () =>
      request(`/platform/participants/${run.id}`, { token: alice.token });
    let state = await participant();
    assert.ok(state.introduction.pending.version);
    assert.equal(
      state.introduction.pending.blocks,
      undefined,
      "polling does not resend image content",
    );
    assert.equal(state.surveys.pending, null);
    assert.deepEqual(
      (await request(`${engine}/introduction`, { token: alice.token })).pending
        .blocks,
      document.blocks,
    );
    await request(`${engine}/surveys/pre/responses`, {
      token: alice.token,
      body: { answers: { support: "Yes" } },
      status: 409,
    });
    await request(`${engine}/rooms`, { token: alice.token, status: 409 });
    const blocked = await request(`/platform/runs/${run.id}/start`, {
      token: owner.token,
      body: {},
      status: 409,
    });
    assert.match(blocked.error, /2 participant.*topic description/);
    await request(`${engine}/introduction/continue`, {
      token: alice.token,
      body: { version: "stale" },
      status: 409,
    });
    await request(`${engine}/introduction/continue`, {
      token: alice.token,
      body: { version: state.introduction.pending.version },
    });
    await request(`${engine}/admin/introduction`, {
      token: owner.token,
      method: "PUT",
      body: document,
      status: 409,
    });
    state = await participant();
    assert.equal(state.introduction.pending, null);
    assert.equal(state.surveys.pending.stage, "pre");
    const worker = platform.manager.workers.get(run.id);
    worker.stopping = true;
    platform.manager.workers.delete(run.id);
    const exited = once(worker.child, "exit");
    worker.child.kill("SIGTERM");
    await exited;
    assert.equal(
      (await participant()).introduction.pending,
      null,
      "acknowledgement survives an engine restart",
    );
    await request(`/platform/participants/${run.id}/logout`, {
      token: alice.token,
      body: {},
    });
    alice = await request(`/platform/invitations/${invite}/join`, {
      body: { recoveryCode: alice.recoveryCode },
    });
    assert.equal(
      (await participant()).introduction.pending,
      null,
      "acknowledgement survives recovery-code reconnect",
    );
    const bobState = await request(`/platform/participants/${run.id}`, {
      token: bob.token,
    });
    await request(`${engine}/introduction/continue`, {
      token: bob.token,
      body: { version: bobState.introduction.pending.version },
    });
    const preflight = await request(`/platform/runs/${run.id}/start`, {
      token: owner.token,
      body: {},
      status: 409,
    });
    assert.match(preflight.error, /pre-experiment survey/);
    for (const participant of [alice, bob])
      await request(`${engine}/surveys/pre/responses`, {
        token: participant.token,
        body: { answers: { support: "Yes" } },
        status: 201,
      });
    await request(`/platform/runs/${run.id}/start`, {
      token: owner.token,
      body: {},
    });
    assert.equal((await participant()).surveys.pending, null);
    await request(`${engine}/introduction/continue`, {
      token: alice.token,
      body: {},
      status: 409,
    });
    const runDb = new Database(path.join(directory, "runs", run.id, "chat.db"));
    runDb
      .prepare(
        "UPDATE system_state SET current_phase = 'completed' WHERE id = 1",
      )
      .run();
    runDb.close();
    await request(`/platform/runs/${run.id}`, { token: owner.token });
    assert.equal((await participant()).surveys.pending.stage, "post");
    await request(`${engine}/surveys/post/responses`, {
      token: alice.token,
      body: { answers: { support: "Yes" } },
      status: 201,
    });
    assert.equal((await participant()).surveys.pending, null);
    const exported = await request(`${engine}/admin/decision-process/export`, {
      token: owner.token,
    });
    assert.equal(exported.configuration.introduction.title, document.title);
    assert.equal(exported.records.introductionAcknowledgements.length, 2);
    const repeated = (
      await request(`/platform/runs/${run.id}/repeat`, {
        token: owner.token,
        body: {},
        status: 201,
      })
    ).run;
    const copied = await request(
      `/platform/runs/${repeated.id}/engine/admin/introduction`,
      { token: owner.token },
    );
    assert.deepEqual(copied.introduction, document);
    assert.equal(copied.locked, false);
    const repeatedExport = await request(
      `/platform/runs/${repeated.id}/engine/admin/decision-process/export`,
      { token: owner.token },
    );
    assert.equal(repeatedExport.records.introductionAcknowledgements.length, 0);
  },
);
