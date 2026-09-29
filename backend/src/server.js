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
import { attachSocketHandlers } from './socket/socketManager.js';
import { initAgent3 } from './services/agent3Service.js';
import fs from 'fs';

initDb();

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
app.use(express.json());

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

app.use('/api', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/decision', decisionRoutes);
app.use('/api/admin', adminRoutes);

// Express 4 does not automatically forward rejected async handlers.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  console.error('Request failed:', error.message);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request' });
});

attachSocketHandlers(io);
initAgent3(io);

server.listen(env.port, () => {
  const protocol = isHttps ? 'https' : 'http';
  console.log(`Backend listening on ${protocol}://localhost:${env.port}`);
});
