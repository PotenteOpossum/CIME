import http from 'http';
import https from 'https';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { initDb } from './config/db.js';
import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import adminRoutes from './routes/admin.js';
import decisionRoutes from './routes/decision.js';
import { surveyAdminRoutes, surveyParticipantRoutes } from './routes/surveys.js';
import { attachSocketHandlers } from './socket/socketManager.js';
import { initAgent3 } from './services/agent3Service.js';
import fs from 'fs';
import { recoverSimulation } from './services/simulationService.js';
import { engineRoutes, initEnginePlatform } from './platform/engineRoutes.js';

initDb();
if (process.env.CIME_ENGINE === 'true') initEnginePlatform();

const app = express();
const corsOptions = {
  origin(origin, callback) {
    if (!origin || env.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: false
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

const isHttps = String(process.env.HTTPS_ENABLED).trim() === 'true';

let server;
if (isHttps) {
  const privateKey = fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8');
  const certificate = fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8');
  const ca = process.env.SSL_CA_PATH ? fs.readFileSync(process.env.SSL_CA_PATH, 'utf8') : undefined;

  const credentials = { key: privateKey, cert: certificate, ca };
  server = https.createServer(credentials, app);
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: {
    origin: env.corsOrigins,
    methods: ['GET', 'POST'],
    credentials: false
  }
});

app.set('io', io);

if (process.env.CIME_ENGINE === 'true') {
  app.use((req, res, next) => {
    if (req.headers['x-cime-engine-key'] !== process.env.CIME_ENGINE_KEY) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
  let timersStarted = process.env.CIME_RUN_ACTIVE === 'true';
  app.use('/_platform', engineRoutes());
  app.use('/api/admin', (req, _res, next) => {
    if (!timersStarted && req.method === 'POST' && ['/decision-process/start', '/simulation/start'].includes(req.path)) { timersStarted = true; initAgent3(io); }
    next();
  });
} else app.use('/api', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/decision', decisionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/surveys', surveyAdminRoutes);
app.use('/api/surveys', surveyParticipantRoutes);

// Express 4 does not automatically forward rejected async handlers.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  console.error('Request failed:', error.message);
  res.status(status).json({
    error:
      status === 500
        ? 'Internal server error'
        : error.message || 'Invalid request',
  });
});

attachSocketHandlers(io);
if (process.env.CIME_ENGINE !== 'true' || process.env.CIME_RUN_ACTIVE === 'true') initAgent3(io);
if (process.env.CIME_RUN_ACTIVE === 'true') recoverSimulation(io);

server.listen(env.port, process.env.HOST || '127.0.0.1', () => {
  const protocol = isHttps ? 'https' : 'http';
  console.log(`Backend listening on ${protocol}://localhost:${server.address().port}`);
  process.send?.({ type: 'ready', port: server.address().port });
});

if (process.env.CIME_ENGINE === 'true') {
  const close = () => { server.close(); process.exit(0); };
  process.once('SIGTERM', close);
  process.once('disconnect', close);
}
