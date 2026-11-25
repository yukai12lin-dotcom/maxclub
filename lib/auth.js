const bcrypt = require('bcryptjs');
const CryptoJS = require('crypto-js');
const { query } = require('./db');

const VIEW_KEY = process.env.PASSWORD_VIEW_KEY || 'default-view-key-change-me';

function encryptPlain(plain) {
  return CryptoJS.AES.encrypt(plain, VIEW_KEY).toString();
}

function decryptPlain(encrypted) {
  try {
    const bytes = CryptoJS.AES.decrypt(encrypted, VIEW_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    return null;
  }
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

async function checkLoginLock(phone) {
  const res = await query('SELECT fail_count, locked_until FROM login_attempts WHERE phone = $1', [phone]);
  if (res.rows.length === 0) return { locked: false };
  const row = res.rows[0];
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    return { locked: true, until: row.locked_until };
  }
  return { locked: false, failCount: row.fail_count || 0 };
}

async function recordLoginFail(phone) {
  const res = await query(
    `INSERT INTO login_attempts (phone, fail_count, locked_until)
     VALUES ($1, 1, NULL)
     ON CONFLICT (phone) DO UPDATE SET fail_count = login_attempts.fail_count + 1
     RETURNING fail_count`,
    [phone]
  );
  const count = res.rows[0].fail_count;
  if (count >= 5) {
    await query(
      `UPDATE login_attempts SET locked_until = NOW() + INTERVAL '1 hour', fail_count = 0 WHERE phone = $1`,
      [phone]
    );
    return { locked: true };
  }
  return { locked: false, failCount: count };
}

async function clearLoginFail(phone) {
  await query('DELETE FROM login_attempts WHERE phone = $1', [phone]);
}

module.exports = {
  encryptPlain,
  decryptPlain,
  hashPassword,
  comparePassword,
  checkLoginLock,
  recordLoginFail,
  clearLoginFail
};
