import { createRouter } from '../middleware/router.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { db } from '../config/db.js';
import { env } from '../config/env.js';

const router = createRouter();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = db
    .prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?')
    .get(username);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin === 1 },
    env.jwtSecret,
    {
      expiresIn: '24h'
    }
  );

  return res.json({
    token,
    user: { id: user.id, username: user.username, is_admin: user.is_admin === 1 }
  });
});

export default router;
