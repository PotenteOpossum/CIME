import { createRemoteJWKSet, jwtVerify } from "jose";
import { fail } from "./security.js";

const keys = createRemoteJWKSet(
  new URL("https://api.prolific.com/.well-known/study/jwks.json"),
);
const idPattern = /^[a-f0-9]{24}$/i;

export async function verifyProlific(
  input,
  config,
  apiToken,
  { fetcher = fetch, keySet = keys } = {},
) {
  let identifiers = input;
  if (config.prolific_verification === "signed") {
    if (!input.prolific_token)
      throw fail(
        401,
        "Open this experiment from Prolific using your secure study link",
      );
    let payload;
    try {
      ({ payload } = await jwtVerify(input.prolific_token, keySet, {
        algorithms: ["RS256"],
        issuer: "https://www.prolific.com",
        audience: config.prolific_audience,
        requiredClaims: ["exp", "iat", "sub"],
      }));
    } catch {
      throw fail(
        401,
        "Invalid or expired Prolific link. Please reopen it from Prolific.",
      );
    }
    identifiers = payload.prolific || {};
    if (
      payload.sub !== identifiers.SESSION_ID ||
      identifiers.workspace_id !== config.prolific_workspace_id ||
      (config.prolific_organisation_id &&
        identifiers.organisation_id !== config.prolific_organisation_id)
    ) {
      throw fail(
        403,
        "This Prolific link does not belong to the configured workspace",
      );
    }
  }
  const {
    PROLIFIC_PID: pid,
    STUDY_ID: study,
    SESSION_ID: session,
  } = identifiers;
  if (
    ![pid, study, session].every(
      (value) => typeof value === "string" && idPattern.test(value),
    )
  )
    throw fail(400, "Missing or invalid Prolific study identifiers");
  if (study !== config.prolific_study_id)
    throw fail(403, "This Prolific study does not match the experiment");
  if (config.prolific_verification === "api") {
    if (!apiToken)
      throw fail(
        503,
        "Prolific verification has not been configured by the administrator",
      );
    let response;
    try {
      response = await fetcher(
        `https://api.prolific.com/api/v1/submissions/${session}/`,
        {
          headers: { Authorization: `Token ${apiToken}` },
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch {
      throw fail(
        503,
        "Prolific verification is temporarily unavailable. Please try again.",
      );
    }
    if (!response.ok)
      throw fail(
        response.status >= 500 || response.status === 429 ? 503 : 403,
        "Unable to verify this Prolific submission",
      );
    const submission = await response.json();
    if (
      submission.participant !== pid ||
      submission.study_id !== study ||
      submission.status !== "ACTIVE"
    )
      throw fail(
        403,
        "This is not an active submission for the configured study",
      );
  } else if (config.prolific_verification !== "signed") {
    throw fail(400, "Choose signed-link or API verification");
  }
  return { pid, study, session };
}
