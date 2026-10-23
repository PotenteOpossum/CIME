# Platform implementation

## Identity and admission

An administrator account owns decisions; a decision has independent runs. Participant identities and sessions belong to a run, not to an administrator login. The same display name can be used in different experiments. A participant's internal numerical ID remains the identity used by the existing decision engine.

| Access mode          | What participants provide       | Admission rule                                                                              |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| Open invitation      | Display name                    | A valid invitation, open registration, space available and a unique run-local name          |
| Assigned credentials | Run-local username and password | Credentials created by the owning admin; bcrypt passwords; no participant self-registration |
| Prolific             | Parameters supplied by Prolific | Verified study submission or signed Prolific study token, matched to the configured study   |

An open link is a bearer invitation: anyone receiving it may join. Display names are not proof of identity. Each admitted participant receives a random recovery code, stored hashed on the server. Recovery or assigned credentials reconnect the existing participant after registration closes. Recovery codes do not bypass a missing or revoked invitation. Browser sessions are scoped to each run; account tokens and participant tokens have different audiences and signing keys. Revocation removes the server session and disconnects its sockets.

## Prolific setup

Choose Prolific access before recruitment and provide the study ID, verification method and optional completion URL. The completion link becomes available only after the decision completes and the participant submits any enabled post-experiment survey. CIME never automatically approves, rejects or pays submissions.

For **API verification**, configure a private Prolific researcher API token. Append these parameters to the physical invitation URL when configuring the external study URL in Prolific:

```text
https://cime.example.org/join/INVITATION_TOKEN?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

The backend retrieves the submission with `SESSION_ID`, checks its participant and study IDs and requires ACTIVE status for a new join. A typed PID alone is never accepted. Verification failures and API outages fail closed. This confirms a matching active submission; URL parameters can still be copied, so use signed links where stronger protection against parameter editing is required. See Prolific's [submissions guide](https://docs.prolific.com/api-reference/submissions/submissions-guide).

For **signed-link verification**, enable signed study links in Prolific and configure the exact audience (study URL), workspace ID and, optionally, organisation ID. CIME verifies `prolific_token` using Prolific's published RSA keys, issuer, signature, expiry, issued-at claim and subject, then matches its study/workspace and the signed PID. The invitation URL remains outside the hash router so external query parameters arrive correctly. After rotating an invitation, update both the study URL and its expected audience. Availability of this feature depends on your Prolific workspace. See the [Prolific JWT verification requirements](https://docs.prolific.com/api-reference/well-known-endpoints/get-study-jwks).

CIME stores PID, study and submission IDs privately alongside the run's internal participant ID. Chat interfaces use a pseudonymous display name. These mappings are included in the owner's export, not in public invitation responses or other participants' socket messages. API credentials are encrypted at rest and never returned to the browser. Recovery codes and password hashes are excluded from exports.

## Code boundaries

Experiment surveys are configured in the process workspace's **Surveys** tab, also linked from the experiment setup page. Each run stores its pre/post definitions in `survey_definitions` and one submission per stage and participant in `survey_responses`. Free text, single-choice, multiple-choice and bounded integer scales support required/optional answers. Conditions refer only to earlier questions, preventing cycles; hidden branches are excluded from validation and stored answers. The browser and server share condition evaluation in `shared/surveyLogic.mjs`.

An enabled pre-survey appears during recruitment. Start closes admission and checks that every admitted human participant submitted it; incomplete surveys restore admission and return an actionable message. Simulation starts bypass this check. The participant gateway permits survey submissions during recruitment and after completion while retaining the normal restrictions on discussion APIs. Survey definitions freeze after the first submission or experiment start. Repeating a run copies definitions and starts with no survey responses.

The owner can download definitions and responses from **Surveys**; complete run exports include them too. Responses contain run-local participant IDs and usernames and remain private to the owning administrator. Interrupted/failed experiments do not collect surveys. Browser drafts use session storage scoped to the run, user and stage; only submitted answers reach the server. These drafts are not a cross-device resume mechanism.

- `backend/src/platform/`: account lifecycle, ownership, invitation/admission policies, Prolific verification, quotas, worker supervision and HTTP/socket gateway.
- `backend/src/storage/`: PostgreSQL adapter preserving the existing synchronous engine transaction interface. A worker thread executes queries; engine processes remain independent.
- `frontend/src/platform/`: homepage, accounts, decision dashboard, run setup, invitation and waiting/completion screens.
- `admin-frontend/src/platform/`: integration of the existing admin controls with owned runs and draft saving.

The gateway authenticates every request and socket before selecting a worker. Broad database tooling and legacy user management are disabled in the hosted workspace; these would bypass ownership and admission policies. Existing deliberation services, poll rules and phase transitions remain the engine of each run. Multi-run exports select the run's frozen participants and carry its configuration snapshot.

PostgreSQL metadata and every engine schema live in the same configured database. Configuration, prompts and logs stay in the persistent data directory. The adapter translates the SQLite-specific statements used by the engine; tests cover full schema initialization, upserts and transactional rollback. Multi-supervisor operation requires an additional durable scheduler, distributed locks and socket routing; PostgreSQL currently rejects a second supervisor through an advisory lock.

## Legacy import

Existing `backend/chat.db` is never automatically reset or reassigned. Create and verify the target platform admin, stop the platform supervisor, and back up the legacy database and its accompanying files. From `backend/`:

```bash
npm run import:legacy -- --source /absolute/path/chat.db --owner admin@example.org --title "Legacy experiment" --config-dir /absolute/path/agent-config --prompts-dir /absolute/path/prompts --logs-dir /absolute/path/logs
```

The importer backs up the SQLite source read-only, checks copied row counts when transferring into PostgreSQL, preserves IDs and credentials, and creates an archived historical run. It never guesses separate historical experiments from message timestamps. The original database remains unchanged. Interrupted historical runs retain their data and do not resume timers. Use Repeat to create a new experiment.

The legacy server is still available through `npm --prefix backend run start:legacy`, but it uses its own database and old admin setup and is not the hosted multi-admin platform.

## Operational limits

A supervisor automatically restores active engine workers and attempts bounded crash recovery. Worker capacity is explicit; inactive workers can be evicted and reopened from storage. Model reservations are atomic and fail closed when the supervisor is unavailable. A checkpoint protects simulation progress, but exactly-once delivery of external model responses across crashes is not guaranteed.

Live model behavior, SMTP delivery, reverse-proxy configuration and a real Prolific workspace must be checked with your deployment credentials. Automated tests deliberately use synthetic accounts, mock Prolific responses/signatures and no billable model calls.

The existing Tailwind 3 build pipeline retains npm advisories in its glob-pattern dependencies (`braces`, `micromatch`, `fast-glob` and `chokidar`). They concern build/watch tooling, which is not served by the production backend. Upgrading to Tailwind 4 requires a separate stylesheet migration to preserve the existing participant and admin appearance; do not run `npm audit fix --force` against this codebase without that migration. Runtime charting/router dependencies and Vite were updated during the platform implementation.

### Topic voting and convergence

The group discussion countdown does not discard unresolved topics or interrupt an open ballot. Each assigned topic completes its swipe, live voting, and ranking fallback as needed before the final general-question vote. A live round with no substantive candidates uses configured topic options for ranking; the Other control is never a ranking candidate. Restart recovery preserves the ranking stage.

Convergence summaries include every configured topic, including topics left unfinished by older runs. Agreement requires every group assigned to that topic to have a decision; unfinished topics stay open for voting. Existing active convergence summary cards are refreshed when their worker starts, without resetting review deadlines or recorded votes.

The personal interview remains sequential. If its countdown ends, the current unanswered topic becomes a ballot; each answer is recorded before the next topic opens. Topic-preference routing (when configured) follows the topic answers, and the personal openness scale is last. Accept/reject voting on the final proposal belongs to the group and convergence phases. Active legacy batches are queued on worker restart without deleting their polls or votes; queued future ballots are excluded from the participant poll feed.

Archived, stopped runs can be permanently deleted from My decisions after confirmation. Deletion removes that run’s database, participants, ballots, messages, reports, and local files; other runs of the decision are retained. The parent decision is removed when its last run is deleted. Audit events and account model usage remain. Draft runs can edit their title and invitation description on the decision page; these values are specific to the run and are copied into subsequent runs. Recruiting and started runs cannot edit these details.

Time before final vote provides 0–1800 seconds of discussion after topic decisions and before the final main-question ballot in groups and convergence. It is separate from Time before poll (0–120 seconds between topics). The final-vote deadline is persisted and enforced for manual requests and restart recovery. Convergence summary timer remains 1–10 minutes and can end early when everyone agrees. Finishing the participant report signs out into a thank-you screen, retaining a Prolific completion link when available.

The decision setup page includes AI generation for the participant introduction and discussion topics, plus individual fields for up to six topic and final voting options. Generated content is reviewed before saving. Live Room Monitoring appears at the bottom only while the run is active; it includes aggregate personal interview progress (excluding admin rooms) and discussion/convergence room cards. The process workspace uses the portal’s green and warm white palette.
