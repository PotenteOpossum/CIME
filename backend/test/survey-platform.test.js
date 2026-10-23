import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "survey-platform-test-secret-at-least-32-characters";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
const { createPlatform } = await import("../src/platform/server.js");

test(
  "surveys follow isolated run lifecycle, protect answers, gate start/completion, and copy definitions on repeat",
  { timeout: 120000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cime-survey-platform-"),
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
      const response = await fetch(`${base}${route}`, {
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
    const registration = await request("/accounts/register", {
      body: {
        email: "surveys@example.com",
        name: "Survey owner",
        password: "secure-test-password-only",
      },
      status: 201,
    });
    const verification = new URLSearchParams(
      new URL(registration.developmentActionUrl).hash.split("?")[1],
    ).get("token");
    await request("/accounts/verify", { body: { token: verification } });
    const owner = await request("/accounts/login", {
      body: {
        email: "surveys@example.com",
        password: "secure-test-password-only",
      },
    });
    const run = (
      await request("/platform/decisions", {
        body: { title: "Survey test" },
        token: owner.token,
        status: 201,
      })
    ).run;
    const config = {
      globalQuestion: "Improve the square?",
      decisionContext: "Public space",
      deliberationQuestions: [
        {
          topic: "trees",
          question_text: "More trees?",
          predefined_answers: ["Yes", "No"],
        },
      ],
    };
    await request(`/platform/runs/${run.id}`, {
      body: { config },
      method: "PATCH",
      token: owner.token,
    });
    const engine = `/platform/runs/${run.id}/engine`;
    const surveys = Object.fromEntries(
      ["pre", "post"].map((stage) => [
        stage,
        {
          enabled: true,
          title: `${stage} survey`,
          description: "",
          questions: [
            {
              id: "choice",
              type: "single_choice",
              label: "Do you agree?",
              required: true,
              options: ["Yes", "No"],
            },
            {
              id: "why",
              type: "text",
              label: "Why not?",
              required: true,
              condition: {
                questionId: "choice",
                operator: "equals",
                value: "No",
              },
            },
          ],
        },
      ]),
    );
    await request(`${engine}/admin/surveys`, {
      method: "PUT",
      body: surveys,
      token: owner.token,
    });
    await request(`/platform/runs/${run.id}/admission`, {
      body: { open: true },
      token: owner.token,
    });
    const invite = new URL(run.invite_url).pathname.split("/").at(-1);
    const alice = await request(`/platform/invitations/${invite}/join`, {
      body: { username: "Alice" },
    });
    const bob = await request(`/platform/invitations/${invite}/join`, {
      body: { username: "Bob" },
    });
    assert.equal(
      (
        await request(`/platform/participants/${run.id}`, {
          token: alice.token,
        })
      ).surveys.pending.stage,
      "pre",
    );
    await request(`${engine}/admin/surveys`, {
      token: alice.token,
      status: 401,
    });
    await request(`${engine}/rooms`, { token: alice.token, status: 409 });
    await request(`${engine}/surveys/post/responses`, {
      body: { answers: { choice: "Yes" } },
      token: alice.token,
      status: 409,
    });
    const invalid = await request(`${engine}/surveys/pre/responses`, {
      body: { answers: { choice: "No" } },
      token: alice.token,
      status: 400,
    });
    assert.match(invalid.error, /Why not/);
    const blocked = await request(`/platform/runs/${run.id}/start`, {
      body: {},
      token: owner.token,
      status: 409,
    });
    assert.match(blocked.error, /2 participant/);
    assert.equal(
      (await request(`/platform/runs/${run.id}`, { token: owner.token })).run
        .admission_open,
      true,
    );
    await request(`${engine}/surveys/pre/responses`, {
      body: { answers: { choice: "No", why: "Prefer discussion" } },
      token: alice.token,
      status: 201,
    });
    await request(`${engine}/admin/surveys`, {
      method: "PUT",
      body: surveys,
      token: owner.token,
      status: 409,
    });
    await request(`${engine}/surveys/pre/responses`, {
      body: { answers: { choice: "Yes" } },
      token: alice.token,
      status: 409,
    });
    assert.equal(
      (await request(`${engine}/surveys`, { token: bob.token })).pending.stage,
      "pre",
    );
    await request(`${engine}/surveys/pre/responses`, {
      body: { answers: { choice: "Yes" } },
      token: bob.token,
      status: 201,
    });
    await request(`/platform/runs/${run.id}/start`, {
      body: {},
      token: owner.token,
    });
    assert.equal(
      (await request(`${engine}/surveys`, { token: alice.token })).pending,
      null,
    );
    const responses = await request(`${engine}/admin/surveys/export`, {
      token: owner.token,
    });
    assert.equal(responses.responses.length, 2);
    assert.equal(
      responses.responses.find((r) => r.username === "Alice").answers.why,
      "Prefer discussion",
    );
    assert.equal(JSON.stringify(responses).includes("password_hash"), false);

    // Drive completion through isolated test storage, without running model calls.
    const runDb = new Database(path.join(directory, "runs", run.id, "chat.db"));
    runDb
      .prepare(
        "UPDATE system_state SET current_phase = 'completed' WHERE id = 1",
      )
      .run();
    runDb.close();
    await request(`/platform/runs/${run.id}`, { token: owner.token });
    const completed = await request(`/platform/participants/${run.id}`, {
      token: alice.token,
    });
    assert.equal(completed.surveys.pending.stage, "post");
    assert.equal(completed.completion_url, null);
    await request(`${engine}/surveys/post/responses`, {
      body: { answers: { choice: "Yes" } },
      token: alice.token,
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
    assert.equal(
      (await request(`${engine}/surveys`, { token: bob.token })).pending.stage,
      "post",
    );
    const repeated = (
      await request(`/platform/runs/${run.id}/repeat`, {
        body: {},
        token: owner.token,
        status: 201,
      })
    ).run;
    const copied = await request(
      `/platform/runs/${repeated.id}/engine/admin/surveys`,
      { token: owner.token },
    );
    assert.equal(
      copied.surveys.post.questions[1].condition.questionId,
      "choice",
    );
    assert.equal(copied.responses.length, 0);
    assert.equal(copied.locked, false);
    await request(`/platform/runs/${repeated.id}/engine/surveys`, {
      token: alice.token,
      status: 401,
    });
  },
);
