import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { db } from '../config/db.js';

export function currentUser(token) {
  const payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'], ...(process.env.CIME_ENGINE === 'true' ? { audience: 'cime-engine' } : {}) });
  if (!Number.isInteger(payload.id)) throw new Error('Invalid account');
  if (process.env.CIME_ENGINE === 'true') {
    if (payload.run !== process.env.CIME_RUN_ID || !db.prepare('SELECT id FROM run_sessions WHERE id = ? AND user_id = ? AND revoked = 0 AND expires_at > ?').get(payload.sid, payload.id, new Date().toISOString())) throw new Error('Invalid session');
  }
  const user = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(payload.id);
  if (!user) throw new Error('Account no longer exists');
  return { id: user.id, username: user.username, is_admin: user.is_admin === 1 };
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];

  try {
    req.user = currentUser(token);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function adminMiddleware(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

export function verifySocketToken(token) {
  if (!token) throw new Error('Missing token');
  return currentUser(token);
}
