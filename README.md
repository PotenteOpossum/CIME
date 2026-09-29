# CIME — Collective Intelligence Made Easy

CIME is a web application for structured collective decision-making. It connects private interviews, small-group discussion, voting, and collective review, with AI-assisted facilitation and explicit backend rules for process control.

For a detailed explanation of the implementation, administrator controls, simulation and quality methods, and experiment setup, see the [CIME implementation and research guide](CIME_GUIDE.md).

## Features

- Private conversations to collect participants' views and topic preferences.
- Group formation and topic-focused discussion with an AI facilitator.
- Approval ballots, revisable live votes, participant-proposed alternatives, and ranking.
- Collective review of subgroup decisions and a final vote on the main question.
- Separate participant and administrator interfaces.
- Configurable prompts, model selection, timing, quorum, and approval settings.
- Poll hand-offs use the configurable `time_before_poll_seconds` delay; `poll_timer_minutes` and the live-voting duration control how long the respective vote stages remain open.
- Participation indicators, automated discussion-quality assessments, and run exports.
- Optional simulated participants configured through the administrator interface.

This repository contains the application and the resources needed to run it. It does not include research experiment runners, test suites, manuscripts, figure-generation scripts, deployment credentials, or previously collected data.

## Architecture

| Component | Purpose |
| --- | --- |
| `backend/` | Express API, Socket.IO events, authentication, SQLite persistence, and workflow coordination |
| `frontend/` | React/Vite participant interface |
| `admin-frontend/` | React/Vite administrator interface |
| `backend/agent-config/` | Agent instructions and prompt templates |
| `backend/prompts/` | Default and locally created room prompts |

Three cooperating backend services divide facilitation responsibilities. Agent 1 handles participant dialogue, Agent 2 organizes groups and their instructions, and Agent 3 coordinates voting and workflow transitions. They share persistent process state and use language models for language-related tasks.

## Requirements

- **Node.js 22.x** and npm. The `.nvmrc` file selects Node.js 22 when using nvm.
- An **OpenAI API key** with access to the chat and embedding models you configure. AI operations make billable API calls.
- A writable local directory for the SQLite database, settings, and logs.
- If native dependency installation requires compilation: Python 3 and a C/C++ build toolchain, such as Xcode Command Line Tools on macOS or the corresponding tools on Linux.

## Local setup

Run the following commands from the repository root.

### 1. Install dependencies

If you use nvm, run `nvm use` first. Then install the three applications using their committed lockfiles:

```bash
npm run install:all
```

### 2. Create local configuration

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp admin-frontend/.env.example admin-frontend/.env
```

Generate a unique JWT signing secret and write it directly into `backend/.env`:

```bash
node -e "const fs = require('node:fs'); const crypto = require('node:crypto'); const p = 'backend/.env'; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + crypto.randomBytes(32).toString('hex')));"
```

Edit `backend/.env` and set:

| Variable | Value to provide |
| --- | --- |
| `OPENAI_API_KEY` | Your API key; keep it on the backend only |
| `OPENAI_MODEL` | The primary chat model available to your account |
| `CHEAP_MODEL` | The default model for calls configured to use the lower-cost model |
| `OPENAI_EMBEDDING_MODEL` | The embedding model; the template uses `text-embedding-3-small` |
| `ADMIN_USERNAME` | Your initial administrator username |
| `ADMIN_PASSWORD` | Your own password, at least 12 characters and no more than 72 UTF-8 bytes |

The chat-model values in the template are application defaults, not a guarantee of availability on every API account. Set them to models your account can use. Task-specific model selections can subsequently be managed in the administrator interface. `CIME_API_KEY` is accepted as an alternative to `OPENAI_API_KEY` and takes precedence when both are set.

The frontend configuration contains only public endpoint URLs. **Never put an API key, password, or JWT secret in a `VITE_` variable:** Vite embeds those values in browser code.

### 3. Create the administrator account

```bash
npm run setup:admin
```

This initializes the database and creates the administrator using the credentials you supplied. It does not create demonstration participants, reset a decision, or overwrite an existing account. After it succeeds, remove `ADMIN_PASSWORD` from `backend/.env`; the account uses the password hash stored in the database.

### 4. Start the application

Open three terminals at the repository root and run one command in each:

**Terminal 1 — backend**

```bash
npm run dev:backend
```

**Terminal 2 — participant interface**

```bash
npm run dev:frontend
```

**Terminal 3 — administrator interface**

```bash
npm run dev:admin
```

| Service | Local address |
| --- | --- |
| Participant interface | http://localhost:5173 |
| Administrator interface | http://localhost:5174 |
| Backend health endpoint | http://localhost:4000/api/health |

Sign in to the administrator interface with the account you created. Press `Ctrl+C` in each terminal to stop its service. Persistent data remains available on the next start.

## Start a deliberation

1. Create participant accounts in the administrator interface and distribute their credentials privately.
2. Define the main question, background context, deliberation topics, and initial voting options.
3. Configure grouping, room sizes, timers, approval thresholds, and quorum.
4. Start the decision process. Participants sign in to the participant interface and begin their private interviews.
5. Monitor group discussions, voting, and collective review through the administrator interface.
6. Inspect the resulting decisions and, if needed, request quality analysis or export the run.

The built-in Simulation tab can exercise the same application with synthetic participants. Its controls and runtime services are included; standalone experiment automation and saved experiment results are not. Automated quality assessments and simulated behavior require interpretation and do not establish how human participants would respond.

## Configuration and stored data

The backend reads `backend/.env` when started through the commands above. Each Vite application reads its own `.env` file.

| Setting | Purpose |
| --- | --- |
| `PORT` | Backend port; defaults to `4000` |
| `CORS_ORIGIN` | Comma-separated allowed browser origins, including scheme and port |
| `VITE_API_BASE_URL` | Backend API URL, including `/api` |
| `VITE_SOCKET_URL` | Backend origin used for Socket.IO |
| `VITE_BASE_PATH` | Frontend asset path; defaults to `/` |
| `BOT_TRIGGER_HANDLE` | Bot mention handle; defaults to `@bot` |

Restart a service after changing its configuration. Rebuild a frontend after changing values used by a deployed build.

Runtime files are created locally and excluded from version control:

- `backend/chat.db` and its SQLite sidecar files: accounts, conversations, ballots, and analysis records.
- `backend/agent-config/settings.json`: current administrator settings.
- `backend/agent-config/default-settings.json`: an administrator-saved settings snapshot, when used.
- `backend/logs/`: decision logs.
- Additional files under `backend/prompts/`: locally created room prompts.

Agent instructions and templates under `backend/agent-config/` are application source files. Review changes before committing them, particularly after editing prompts in the administrator interface. Database records, model-call logs, and exported runs may contain participant information. Back up a stopped backend's database together with its configuration and prompts; keep backups outside the public repository.

## Build and deployment

Build both browser applications:

```bash
npm run build
```

The static outputs are `frontend/dist/` and `admin-frontend/dist/`. Serve them using a web server or static hosting service. Start the API separately:

```bash
npm run start:backend
```

For a remote deployment:

- Set the frontend API and Socket.IO URLs to the externally reachable backend origin before building. Use HTTPS URLs when serving the interfaces over HTTPS.
- Set `CORS_ORIGIN` to the actual participant and administrator origins.
- Set `VITE_BASE_PATH` when serving an interface below a URL subdirectory.
- Use a reverse proxy with WebSocket support for Socket.IO and keep the backend data directory persistent and writable.
- Run one backend process. Multiple workers require additional coordination beyond the current shared SQLite state and in-process workflow scheduling.
- Supply deployment secrets through the server environment or an untracked `.env` file. No shared accounts, API credentials, certificates, or server-specific deployment commands are included.

Vite's development and preview servers are intended for local development and build inspection. The backend also supports direct TLS through `HTTPS_ENABLED`, `SSL_KEY_PATH`, `SSL_CERT_PATH`, and optional `SSL_CA_PATH`.

## Troubleshooting

- **Backend refuses to start because of `JWT_SECRET`:** generate the secret using the setup command above. At least 32 characters are required.
- **Administrator login fails:** create the account first, use the credentials you supplied, and confirm the backend is using the intended database. Re-running setup does not reset an existing password.
- **Model access or authentication errors:** check the backend API key and configured model IDs. Restart the backend after changing `.env`; also inspect any model overrides saved in the administrator interface.
- **Browser cannot connect:** check the backend health endpoint, both frontend endpoint variables, and the allowed CORS origins. API URLs end in `/api`; Socket.IO URLs do not.
- **A frontend port is occupied:** free the port or explicitly choose another port and update CORS. Development servers do not silently switch to another port.
- **Native SQLite or bcrypt installation fails:** confirm Node.js 22 is selected and that the native build prerequisites are installed, then retry dependency installation.

## License

CIME is open-source software licensed under the [MIT License](LICENSE). You may use, modify, and redistribute it, including commercially, provided you retain the copyright and license notice. Third-party dependencies remain subject to their respective licenses.
