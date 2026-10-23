import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-secret-which-is-longer-than-32-characters";
const { verifyProlific } = await import("../src/platform/prolific.js");
const ids = {
  PROLIFIC_PID: "aaaaaaaaaaaaaaaaaaaaaaaa",
  STUDY_ID: "bbbbbbbbbbbbbbbbbbbbbbbb",
  SESSION_ID: "cccccccccccccccccccccccc",
};
test("Prolific API validates participant, study and active submission and fails closed", async () => {
  const config = {
    prolific_verification: "api",
    prolific_study_id: ids.STUDY_ID,
  };
  const success = async () => ({
    ok: true,
    json: async () => ({
      participant: ids.PROLIFIC_PID,
      study_id: ids.STUDY_ID,
      status: "ACTIVE",
    }),
  });
  assert.deepEqual(
    await verifyProlific(ids, config, "secret", { fetcher: success }),
    { pid: ids.PROLIFIC_PID, study: ids.STUDY_ID, session: ids.SESSION_ID },
  );
  await assert.rejects(
    verifyProlific({ ...ids, STUDY_ID: ids.PROLIFIC_PID }, config, "secret"),
    { status: 403 },
  );
  await assert.rejects(verifyProlific(ids, config, "", { fetcher: success }), {
    status: 503,
  });
  await assert.rejects(
    verifyProlific(ids, config, "secret", {
      fetcher: async () => ({
        ok: true,
        json: async () => ({
          participant: ids.PROLIFIC_PID,
          study_id: ids.STUDY_ID,
          status: "RETURNED",
        }),
      }),
    }),
    { status: 403 },
  );
  await assert.rejects(
    verifyProlific(ids, config, "secret", {
      fetcher: async () => {
        throw new Error("network unavailable");
      },
    }),
    { status: 503 },
  );
});
test("signed Prolific links verify signature, expiry, audience, workspace and study", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const config = {
    prolific_verification: "signed",
    prolific_study_id: ids.STUDY_ID,
    prolific_workspace_id: "dddddddddddddddddddddddd",
    prolific_audience: "https://cime.example/join/invitation",
  };
  async function sign({
    workspace = config.prolific_workspace_id,
    audience = config.prolific_audience,
    expires = "2m",
  } = {}) {
    return new SignJWT({ prolific: { ...ids, workspace_id: workspace } })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://www.prolific.com")
      .setAudience(audience)
      .setSubject(ids.SESSION_ID)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(privateKey);
  }
  const token = await sign();
  assert.equal(
    (
      await verifyProlific({ prolific_token: token, ...ids }, config, "", {
        keySet: publicKey,
      })
    ).pid,
    ids.PROLIFIC_PID,
  );
  await assert.rejects(
    verifyProlific(
      { prolific_token: await sign({ audience: "wrong" }) },
      config,
      "",
      { keySet: publicKey },
    ),
    { status: 401 },
  );
  await assert.rejects(
    verifyProlific(
      {
        prolific_token: await sign({
          expires: Math.floor(Date.now() / 1000) - 30,
        }),
      },
      config,
      "",
      { keySet: publicKey },
    ),
    { status: 401 },
  );
  await assert.rejects(
    verifyProlific(
      { prolific_token: await sign({ workspace: "eeeeeeeeeeeeeeeeeeeeeeee" }) },
      config,
      "",
      { keySet: publicKey },
    ),
    { status: 403 },
  );
  await assert.rejects(verifyProlific(ids, config, ""), { status: 401 });
});
