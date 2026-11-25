const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log('executed query', { text: text.substring(0, 60), duration, rows: res.rowCount });
  }
  return res;
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_plain TEXT, -- encrypted with PASSWORD_VIEW_KEY for admin view
      name VARCHAR(100),
      role VARCHAR(20) NOT NULL DEFAULT 'boss', -- admin / boss / player
      status VARCHAR(20) DEFAULT 'pending', -- pending / active / suspended
      verification_code VARCHAR(10),
      verification_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      suspended_until TIMESTAMPTZ,
      avatar_url TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      boss_id INTEGER REFERENCES users(id),
      player_id INTEGER REFERENCES users(id),
      player2_id INTEGER REFERENCES users(id), -- 雙人單
      amount INTEGER NOT NULL, -- 單位：元
      product_name VARCHAR(200) DEFAULT '代打',
      scheduled_at TIMESTAMPTZ,
      note TEXT,
      status VARCHAR(30) DEFAULT 'pending', -- pending / accepted / in_room / completed / cancelled / timeout
      screenshot_url TEXT,
      rating INTEGER,
      rating_comment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      cancel_reason TEXT,
      is_urgent BOOLEAN DEFAULT FALSE,
      admin_note TEXT
    );

    CREATE TABLE IF NOT EXISTS order_logs (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id),
      user_id INTEGER REFERENCES users(id),
      action VARCHAR(50),
      detail TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fixed_costs (
      id SERIAL PRIMARY KEY,
      year_month VARCHAR(7) NOT NULL, -- 2026-11
      name VARCHAR(100),
      amount INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      phone VARCHAR(20) PRIMARY KEY,
      fail_count INTEGER DEFAULT 0,
      locked_until TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_boss ON orders(boss_id);
    CREATE INDEX IF NOT EXISTS idx_orders_player ON orders(player_id);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  `);

  // 確保管理員存在
  const adminPhone = process.env.ADMIN_PHONE || '0963696619';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123456';
  const bcrypt = require('bcryptjs');
  const CryptoJS = require('crypto-js');
  const viewKey = process.env.PASSWORD_VIEW_KEY || 'default-view-key-change-me';

  const existing = await query('SELECT id FROM users WHERE phone = $1', [adminPhone]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(adminPass, 10);
    const plainEnc = CryptoJS.AES.encrypt(adminPass, viewKey).toString();
    await query(
      `INSERT INTO users (phone, password_hash, password_plain, name, role, status)
       VALUES ($1, $2, $3, $4, 'admin', 'active')`,
      [adminPhone, hash, plainEnc, '管理員']
    );
    console.log('Admin account created:', adminPhone);
  }
}

module.exports = { pool, query, initDb };
