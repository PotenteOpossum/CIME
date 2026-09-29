import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { db } from '../config/db.js';

function currentUser(token) {
  const payload = jwt.verify(token, env.jwtSecret);
  if (!Number.isInteger(payload.id)) throw new Error('Invalid account');
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
