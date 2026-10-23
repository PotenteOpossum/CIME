# CIME — Collective Intelligence Made Easy

CIME supports independent administrators running structured collective decisions. Administrators register and verify their email, configure a decision, invite participants by URL or QR code, and monitor the existing interview, grouping, discussion, voting and collective-review process.

## Local setup

Use Node.js 22.12 or newer within the 22.x release line. From the repository root:

```bash
npm run install:all
cp backend/.env.example backend/.env
node -e "const fs=require('node:fs'),crypto=require('node:crypto'),p='backend/.env'; fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/^JWT_SECRET=.*$/m,'JWT_SECRET='+crypto.randomBytes(32).toString('hex')))"
```

Set your own backend `OPENAI_API_KEY` and available chat models in `backend/.env`. The application can start without a model key, but AI-assisted stages require one. Never put secrets in browser `VITE_` variables.

Start three terminals:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:admin
```

Open **http://localhost:5173**. Register an administrator account. Without SMTP in local development, the verification link is shown in the registration response and saved in `backend/data/mail/outbox.jsonl`. In production, use SMTP for automatic emails or explicitly set `CIME_MAIL_MODE=outbox` for manual delivery of links from the private server outbox. Production API responses do not expose those links. The old `setup:admin` command belongs to the legacy server and is not needed for platform accounts.

For a single local server serving compiled interfaces:

```bash
npm run build
```

Set `PUBLIC_APP_URL=http://localhost:4000` in `backend/.env`, then run `npm start` and open that address. The backend health endpoint is `/api/health`; the process workspace is served under `/admin/`.

## Running an experiment

1. Create a decision from **My decisions**. Enter its question, background, topics and initial voting options.
2. Choose participant access: **anyone with the link**, **assigned username/password**, or **Prolific**. Configure the participant limit and optional Prolific completion URL.
3. For assigned credentials, enter one username per line, generate passwords, and download the credential CSV. Keep it private; passwords are hashed and cannot be retrieved later.
4. Open recruitment and share the invitation URL or download its QR code. Participants join a waiting room. Their private recovery code lets them reconnect without creating a second participant.
5. Use **Open process workspace** to adjust the existing prompts, models, timing and grouping controls. Save the draft before returning to the invitation page.
6. Start when the required participants have joined. Registration closes and the roster is frozen. The existing decision phases and voting rules continue.
7. Monitor and export results in the process workspace. **Repeat as a new run** copies configuration and prompts into fresh storage; earlier participants and results remain in the original run. Simulations use a fresh run without human participants.

Access mode and identity-verification settings lock after the first participant joins. Started runs retain their configuration. Session revocation disconnects a participant; it does not ban their identity from reconnecting. A rotated invitation invalidates the previous URL and QR code.

## Experiment surveys

Use **Edit surveys & view responses** on the experiment setup page, or **Surveys** in the process workspace. Enable a survey before the experiment, after it, or both. Each question can collect free text, a single choice, multiple choices, or an integer scale with labelled endpoints. Questions can be required or optional.

The **Before experiment** and **After experiment** cards select independent questionnaires; the heading identifies the one you are editing. Switch between **Form editor** and **JSON editor** to edit the same questionnaire. The JSON editor supports paste, **Validate & format**, and **Copy JSON**. **Import JSON file** loads a questionnaire into the selected survey; **Download survey JSON** saves that questionnaire without participant responses. Changes are drafts until you click **Save survey changes**, which saves edits to both questionnaires.

Each questionnaire file uses `"stage": "pre"` or `"stage": "post"` to prevent importing it into the wrong slot. Questions can be nested under groups, each with a shared heading and instruction shown once; legacy flat question arrays remain importable. See the editable [pre-survey example](examples/surveys/pre-survey.json) and [post-survey example](examples/surveys/post-survey.json) for all question types and branching. Keep question IDs stable when editing conditions. Invalid JSON or conditions are rejected before saving, and switching between surveys preserves their separate JSON drafts.

To branch, set **Show this question** to an earlier question and choose the answer condition. For example, show question A when an answer **is Yes**, and question B when it **is not Yes**. Multiple selections support **includes/does not include**, and scales also support **is at least/is at most**. Conditional questions stay hidden until their source is answered; hidden answers are discarded if participants change branches. Text conditions compare the complete trimmed answer, with case preserved.

Save both surveys before inviting participants. Pre-surveys appear in the waiting room, and every admitted participant must submit before the administrator can start the experiment. Post-surveys appear after the decision completes, before the Prolific completion link. Disabled surveys add no extra step; simulated participants skip surveys.

Survey definitions lock after the first response or experiment start. **Repeat as a new run** copies the definitions into an editable fresh run without copying responses. The Surveys page shows submission counts and downloads a JSON file containing definitions, question IDs, answers, participant IDs/usernames, run IDs, and timestamps. Survey responses are also included in the complete run export. They are private research data visible to the owning administrator, not anonymous data. Participant drafts stay in that browser session until submission.

## Storage and deployment

Local development uses SQLite: `backend/data/platform.db` stores accounts, ownership and invitations, while `backend/data/runs/<run-id>/` stores each run's database, configuration, prompts and logs.

Production uses PostgreSQL 16 or newer via `DATABASE_URL`, with shared metadata in `cime_platform` and one schema per run. A separate engine process per active run isolates workflow timers, sockets and in-memory state while preserving the decision engine. Run **one platform supervisor per database**. This implementation supports many registered admins and a bounded number of simultaneous experiments; it is not an unbounded distributed worker cluster.

Production requires:

- `NODE_ENV=production`, `DATABASE_URL`, and an HTTPS `PUBLIC_APP_URL`. For account verification and password resets, configure `SMTP_URL` with a valid `MAIL_FROM`, or set `CIME_MAIL_MODE=outbox` and deliver links manually from `CIME_DATA_DIR/mail/outbox.jsonl`.
- A reverse proxy serving the same origin, forwarding WebSockets, and terminating HTTPS. Set `TRUST_PROXY_HOPS` to the trusted proxy count and `CORS_ORIGIN` to the public origin.
- Persistent `CIME_DATA_DIR` storage for prompts, settings, logs and import snapshots, even with PostgreSQL.
- A stable, private `JWT_SECRET`: it signs sessions and encrypts stored Prolific API credentials. Back it up securely with the database and data directory.

Build both frontends before starting the production backend. The server serves both builds. Do not expose engine worker ports; they bind to loopback and require an internal secret. Back up PostgreSQL and the data directory together. Stop the supervisor before restoring data or importing legacy state.

Limits in `backend/.env.example` bound workers, runs, participants and model calls. Model-call budgets count attempts, including failed requests, per run and per admin per UTC day. They bound call counts, not monetary costs or token usage. Active runs restore persisted deadlines and simulation checkpoints after a restart; interrupted/archived runs do not resume.

See [the platform implementation and Prolific guide](PLATFORM.md) for integration details, migration and limitations. The existing [CIME decision-engine guide](CIME_GUIDE.md) explains the deliberation rules and advanced controls; its legacy login/storage setup has been superseded by this README.

## Verification

```bash
npm test
npm run build
```

Tests use temporary data and no external model calls. They cover account lifecycle, ownership, access modes, isolation over HTTP and WebSockets, admission freezing, reconnection, exports, restart recovery, model budgets, legacy import and Prolific verification. PostgreSQL engine tests use PGlite by default; set `TEST_DATABASE_URL` to a dedicated disposable PostgreSQL database to test the actual PostgreSQL server and platform metadata. Never use a production database for tests.

## License

[MIT](LICENSE).
