import express from "express";
import cors from "cors";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { io as connectEngine } from "socket.io-client";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { openStore } from "./store.js";
import { WorkerManager } from "./workerManager.js";
import { accountRoutes } from "./accounts.js";
import { platformRoutes } from "./routes.js";
import { engineSecret, fail, now } from "./security.js";

export async function createPlatform({
  dataDir = path.resolve(process.env.CIME_DATA_DIR || "data"),
  publicUrl = process.env.PUBLIC_APP_URL || "http://localhost:5173",
  store: providedStore,
} = {}) {
  publicUrl = publicUrl.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    if (
      !process.env.DATABASE_URL ||
      !process.env.SMTP_URL ||
      !/^https:\/\//.test(publicUrl)
    )
      throw new Error(
        "Production requires DATABASE_URL, SMTP_URL and an HTTPS PUBLIC_APP_URL",
      );
  }
  const store = providedStore || (await openStore({ dataDir }));
  const manager = new WorkerManager(store, dataDir);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 0));
  app.use(cors({ origin: env.corsOrigins, credentials: false }));
  app.use(express.json({ limit: "256kb" }));
  app.use((_req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    if (_req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    next();
  });
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: env.corsOrigins },
    maxHttpBufferSize: 256 * 1024,
  });
  const platform = platformRoutes(store, manager, {
    publicUrl,
    onParticipantRevoke: (runId, match) => {
      for (const socket of io.sockets.sockets.values())
        if (
          socket.data.run?.id === runId &&
          ((match.userId && socket.data.participantId === match.userId) ||
            (match.sid && socket.data.participantSession === match.sid))
        )
          socket.disconnect(true);
    },
  });
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, service: "cime-platform" }),
  );
  app.use(
    "/api/accounts",
    accountRoutes(store, {
      dataDir,
      publicUrl,
      onLogout: async (sid) => {
        for (const socket of io.sockets.sockets.values())
          if (socket.data.accountSession === sid) socket.disconnect(true);
      },
    }),
  );
  app.use("/api/platform", platform.router);

  io.use(async (socket, next) => {
    try {
      const { token, runId, admin } = socket.handshake.auth || {};
      if (
        typeof token !== "string" ||
        typeof runId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(runId)
      )
        throw fail(401, "Invalid session");
      let run, engineToken;
      if (admin) {
        const payload = jwt.verify(token, env.jwtSecret, {
          algorithms: ["HS256"],
          audience: "cime-platform",
        });
        const [session] = await store.query(
          "SELECT account_id FROM account_sessions WHERE id = ? AND expires_at > ?",
          [payload.sid, now()],
        );
        if (!session) throw fail(401, "Please sign in again");
        run = await platform.service.owned(runId, session.account_id);
        socket.data.accountSession = payload.sid;
        engineToken = (
          await manager.call(run, "/owner-session", { method: "POST" })
        ).token;
      } else {
        const entry = await platform.participant({
          headers: { authorization: `Bearer ${token}` },
          params: { id: runId },
        });
        run = entry.run;
        engineToken = token;
        socket.data.participantId = entry.session.user.id;
        socket.data.participantSession = entry.payload.sid;
        if (!["active", "completed", "interrupted"].includes(run.status))
          throw fail(403, "Please wait for the administrator to start");
      }
      socket.data.run = run;
      socket.data.engineToken = engineToken;
      next();
    } catch (error) {
      next(
        new Error(
          error.status && error.status < 500
            ? error.message
            : "Unable to connect to this experiment",
        ),
      );
    }
  });
  io.on("connection", async (socket) => {
    const run = socket.data.run;
    let worker;
    try {
      worker = await manager.ensure(run);
    } catch {
      socket.conn.close();
      return;
    }
    if (!socket.connected) return;
    const upstream = connectEngine(worker.url, {
      auth: { token: socket.data.engineToken },
      transports: ["websocket"],
      reconnection: false,
    });
    let sent = 0;
    const reset = setInterval(() => {
      sent = 0;
    }, 1000);
    // Buffer only a bounded number of events while the upstream connects.
    socket.onAny((event, ...args) => {
      if (++sent > 60 || event.startsWith("_")) return;
      if (
        worker.run.status !== "active" &&
        !socket.data.accountSession &&
        !["join_room", "leave_room"].includes(event)
      )
        return;
      upstream.emit(event, ...args);
    });
    upstream.onAny((event, ...args) => {
      if (socket.connected) socket.emit(event, ...args);
    });
    upstream.on("connect_error", () => socket.conn.close());
    upstream.on("disconnect", () => {
      if (socket.connected) socket.conn.close();
    });
    socket.on("disconnect", () => {
      clearInterval(reset);
      upstream.disconnect();
      if (socket.data.accountSession) {
        const payload = jwt.decode(socket.data.engineToken);
        manager
          .call(run, "/revoke", { method: "POST", body: { sid: payload.sid } })
          .catch(() => {});
      }
    });
  });

  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const frontend = path.join(root, "frontend/dist");
  const adminFrontend = path.join(root, "admin-frontend/dist");
  app.use("/admin", express.static(adminFrontend));
  app.get("/admin/*", (_req, res, next) =>
    fs.existsSync(path.join(adminFrontend, "index.html"))
      ? res.sendFile(path.join(adminFrontend, "index.html"))
      : next(),
  );
  app.use(express.static(frontend));
  app.get(
    ["/", "/join/:invite", "/participate/:runId", "/participate/:runId/"],
    (_req, res, next) =>
      fs.existsSync(path.join(frontend, "index.html"))
        ? res.sendFile(path.join(frontend, "index.html"))
        : next(),
  );
  app.use((_req, res) => res.status(404).json({ error: "Endpoint not found" }));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error("Platform request failed:", error.message);
    res.status(status).json({
      error:
        status >= 500 && status !== 503
          ? "Unable to complete this request"
          : error.message,
    });
  });

  await manager.recover();
  const sweep = setInterval(async () => {
    for (const worker of manager.workers.values()) {
      if (!["active", "starting"].includes(worker.run.status)) continue;
      try {
        const state = await manager.call(worker.run, "/state");
        if (state.phase === "completed") {
          worker.run.status = "completed";
          await store.query(
            "UPDATE runs SET status = 'completed' WHERE id = ?",
            [worker.run.id],
          );
        }
      } catch (error) {
        console.error("Run state refresh failed:", error.message);
      }
    }
    await store.query("DELETE FROM account_sessions WHERE expires_at < ?", [
      now(),
    ]);
    await store.query("DELETE FROM account_actions WHERE expires_at < ?", [
      now(),
    ]);
  }, 15000);
  sweep.unref();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(sweep);
    io.close();
    await manager.close();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  };
  return { app, server, io, store, manager, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = await createPlatform();
  platform.server.listen(env.port, process.env.HOST || "127.0.0.1", () =>
    console.log(
      `CIME platform listening on port ${platform.server.address().port}`,
    ),
  );
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      if (closing) return;
      closing = true;
      await platform.close();
      process.exit(0);
    });
}
