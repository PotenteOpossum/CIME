import 'dotenv/config';
import bcrypt from 'bcrypt';

const username = process.env.ADMIN_USERNAME?.trim();
const password = process.env.ADMIN_PASSWORD || '';
if (!username || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
  console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD in backend/.env. Use a password of at least 12 characters and at most 72 UTF-8 bytes.');
  process.exit(1);
}
const { db, initDb, ensurePersonalRoomsForAllUsers } = await import('./config/db.js');
try {
  initDb();
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    throw new Error('That username already exists. No account or password was changed.');
  }
  const hash = bcrypt.hashSync(password, 12);
  db.transaction(() => {
    db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run(username, hash);
    ensurePersonalRoomsForAllUsers();
  })();
  console.log('Administrator created. Remove ADMIN_PASSWORD from backend/.env after setup.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
