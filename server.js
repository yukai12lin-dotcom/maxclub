require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const fs = require('fs');

const { pool, query, initDb } = require('./lib/db');
const authLib = require('./lib/auth');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ===== 中間件 =====
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session（存 PostgreSQL）
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'change-me-to-a-long-random-string',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Rate limit
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: '請求太頻繁，請稍後再試' }
});
app.use('/api/', limiter);

// 上傳設定（截圖）
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|webp|gif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('只允許圖片'));
  }
});

// ===== 認證中間件 =====
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '請先登入' });
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId || !roles.includes(req.session.role)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: '權限不足' });
      return res.redirect('/');
    }
    next();
  };
}

// 注入當前使用者
app.use(async (req, res, next) => {
  res.locals.user = null;
  res.locals.roleLabel = '';
  if (req.session.userId) {
    try {
      const r = await query('SELECT id, phone, name, role, status, avatar_url FROM users WHERE id = $1', [req.session.userId]);
      if (r.rows[0]) {
        res.locals.user = r.rows[0];
        const map = { admin: '管理員', boss: '老闆', player: '打手' };
        res.locals.roleLabel = map[r.rows[0].role] || '';
      }
    } catch (e) {}
  }
  next();
});

// ===== 頁面路由 =====
app.get('/', requireLogin, (req, res) => {
  const role = req.session.role;
  if (role === 'admin') return res.redirect('/admin');
  if (role === 'player') return res.redirect('/player');
  return res.redirect('/boss');
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null });
});

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('register', { error: null, step: 1 });
});

app.get('/verify', requireLogin, (req, res) => {
  res.render('verify', { error: null });
});

// ===== API：登入（已拿掉滑塊，嚴格檢查） =====
app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: '請輸入手機號和密碼' });

    const lock = await authLib.checkLoginLock(phone);
    if (lock.locked) {
      return res.status(429).json({ error: `帳號已鎖定，請於 ${dayjs(lock.until).format('HH:mm')} 後再試` });
    }

    const r = await query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (r.rows.length === 0) {
      await authLib.recordLoginFail(phone);
      return res.status(401).json({ error: '手機號或密碼錯誤' });
    }

    const user = r.rows[0];

    // 嚴格：必須已開通且未停權
    if (user.status === 'pending') {
      return res.status(403).json({ error: '帳號尚未通過驗證，請聯繫客服取得驗證碼後完成註冊' });
    }
    if (user.status === 'suspended' || (user.suspended_until && new Date(user.suspended_until) > new Date())) {
      return res.status(403).json({ error: '帳號已停權，請聯繫管理員' });
    }

    const ok = await authLib.comparePassword(password, user.password_hash);
    if (!ok) {
      const fail = await authLib.recordLoginFail(phone);
      if (fail.locked) return res.status(429).json({ error: '連續錯誤 5 次，帳號鎖定 1 小時' });
      return res.status(401).json({ error: '手機號或密碼錯誤' });
    }

    await authLib.clearLoginFail(phone);
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.phone = user.phone;
    req.session.name = user.name;

    res.json({ ok: true, role: user.role, name: user.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ===== 老闆註冊（兩步：送資料 → 等驗證碼） =====
app.post('/api/register', async (req, res) => {
  try {
    const { phone, password, name } = req.body;
    if (!phone || !password || !name) return res.status(400).json({ error: '請填寫完整資料' });
    if (password.length < 6) return res.status(400).json({ error: '密碼至少 6 位' });

    const exist = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (exist.rows.length > 0) return res.status(400).json({ error: '此手機號已註冊' });

    const hash = await authLib.hashPassword(password);
    const plainEnc = authLib.encryptPlain(password);

    await query(
      `INSERT INTO users (phone, password_hash, password_plain, name, role, status)
       VALUES ($1, $2, $3, $4, 'boss', 'pending')`,
      [phone, hash, plainEnc, name]
    );

    // 通知管理員（可接企業微信）
    await sendWechatNotify(`【新老闆註冊】\n姓名：${name}\n電話：${phone}\n請到後台產生驗證碼`);

    res.json({ ok: true, message: '資料已送出，請聯繫客服取得驗證碼後完成開通' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '註冊失敗' });
  }
});

// 老闆輸入驗證碼完成開通
app.post('/api/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: '請輸入手機號和驗證碼' });

    const r = await query(
      `SELECT * FROM users WHERE phone = $1 AND role = 'boss' AND status = 'pending'`,
      [phone]
    );
    if (r.rows.length === 0) return res.status(400).json({ error: '找不到待驗證帳號' });

    const user = r.rows[0];
    if (!user.verification_code || user.verification_code !== code.trim()) {
      return res.status(400).json({ error: '驗證碼錯誤' });
    }
    if (user.verification_expires && new Date(user.verification_expires) < new Date()) {
      return res.status(400).json({ error: '驗證碼已過期，請重新請客服產生' });
    }

    await query(
      `UPDATE users SET status = 'active', verification_code = NULL, verification_expires = NULL WHERE id = $1`,
      [user.id]
    );

    res.json({ ok: true, message: '驗證成功，現在可以登入了' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '驗證失敗' });
  }
});

// ===== 管理員：產生驗證碼 =====
app.post('/api/admin/generate-code', requireLogin, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.body;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = dayjs().add(30, 'minute').toISOString();

    await query(
      `UPDATE users SET verification_code = $1, verification_expires = $2 WHERE id = $3 AND status = 'pending'`,
      [code, expires, userId]
    );

    const u = await query('SELECT phone, name FROM users WHERE id = $1', [userId]);
    await sendWechatNotify(`【驗證碼已產生】\n${u.rows[0]?.name} (${u.rows[0]?.phone})\n驗證碼：${code}\n30分鐘有效`);

    res.json({ ok: true, code }); // 後台可直接看到
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '產生失敗' });
  }
});

// ===== 訂單相關 =====
app.post('/api/orders', requireLogin, requireRole('boss', 'admin'), async (req, res) => {
  try {
    const { amount, product_name, scheduled_at, note, boss_id } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: '金額不正確' });

    let bossId = req.session.userId;
    if (req.session.role === 'admin' && boss_id) bossId = boss_id; // 代客下單

    const r = await query(
      `INSERT INTO orders (boss_id, amount, product_name, scheduled_at, note, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [bossId, amount, product_name || '代打', scheduled_at || null, note || null]
    );

    await logOrder(r.rows[0].id, req.session.userId, 'create', `金額 ${amount}`);
    await sendWechatNotify(`【新訂單】#${r.rows[0].id} NT$${amount} ${product_name || ''}`);

    res.json({ ok: true, order: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '下單失敗' });
  }
});

// 打手接單
app.post('/api/orders/:id/accept', requireLogin, requireRole('player'), async (req, res) => {
  try {
    const orderId = req.params.id;
    const r = await query('SELECT * FROM orders WHERE id = $1 AND status = $2', [orderId, 'pending']);
    if (r.rows.length === 0) return res.status(400).json({ error: '訂單不存在或已被接' });

    await query(
      `UPDATE orders SET status = 'accepted', player_id = $1, accepted_at = NOW() WHERE id = $2`,
      [req.session.userId, orderId]
    );
    await logOrder(orderId, req.session.userId, 'accept', null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '接單失敗' });
  }
});

// 已進房
app.post('/api/orders/:id/enter-room', requireLogin, requireRole('player'), async (req, res) => {
  try {
    const orderId = req.params.id;
    await query(
      `UPDATE orders SET status = 'in_room' WHERE id = $1 AND player_id = $2 AND status = 'accepted'`,
      [orderId, req.session.userId]
    );
    await logOrder(orderId, req.session.userId, 'enter_room', null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '操作失敗' });
  }
});

// 上傳戰績圖 + 結單（已移除選槍枝）
app.post('/api/orders/:id/complete', requireLogin, requireRole('player'), upload.single('screenshot'), async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!req.file) return res.status(400).json({ error: '請上傳戰績截圖' });

    const url = `/uploads/${req.file.filename}`;
    await query(
      `UPDATE orders SET status = 'completed', screenshot_url = $1, completed_at = NOW()
       WHERE id = $2 AND player_id = $3 AND status IN ('accepted', 'in_room')`,
      [url, orderId, req.session.userId]
    );
    await logOrder(orderId, req.session.userId, 'complete', url);
    await sendWechatNotify(`【結單】#${orderId} 已完成`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '結單失敗' });
  }
});

// 老闆評分
app.post('/api/orders/:id/rate', requireLogin, requireRole('boss'), async (req, res) => {
  try {
    const { rating, comment } = req.body;
    await query(
      `UPDATE orders SET rating = $1, rating_comment = $2 WHERE id = $3 AND boss_id = $4 AND status = 'completed'`,
      [rating, comment || null, req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '評分失敗' });
  }
});

// 取消 / 催單 / 延後 / 回報問題 / 再來一單
app.post('/api/orders/:id/action', requireLogin, async (req, res) => {
  try {
    const { action, reason, new_time } = req.body;
    const orderId = req.params.id;
    const userId = req.session.userId;
    const role = req.session.role;

    const r = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (r.rows.length === 0) return res.status(404).json({ error: '訂單不存在' });
    const order = r.rows[0];

    if (action === 'cancel') {
      if (role !== 'boss' && role !== 'admin' && role !== 'player') return res.status(403).json({ error: '無權限' });
      await query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1 WHERE id = $2`,
        [reason || '', orderId]
      );
      await logOrder(orderId, userId, 'cancel', reason);
      await sendWechatNotify(`【取消訂單】#${orderId} 原因：${reason || '無'}`);
    } else if (action === 'urge') {
      if (role !== 'boss') return res.status(403).json({ error: '只有老闆可催單' });
      await query(`UPDATE orders SET is_urgent = TRUE WHERE id = $1`, [orderId]);
      await logOrder(orderId, userId, 'urge', null);
      await sendWechatNotify(`【催單】#${orderId} 老闆催促中`);
    } else if (action === 'delay') {
      if (role !== 'player') return res.status(403).json({ error: '只有打手可申請延後' });
      // 簡化：直接更新時間，實際可加老闆同意流程
      if (new_time) {
        await query(`UPDATE orders SET scheduled_at = $1 WHERE id = $2`, [new_time, orderId]);
      }
      await logOrder(orderId, userId, 'delay', new_time);
    } else if (action === 'report') {
      await logOrder(orderId, userId, 'report', reason);
      await sendWechatNotify(`【回報問題】#${orderId}\n${reason || ''}`);
    } else if (action === 'reorder') {
      // 再來一單：複製原訂單
      if (role !== 'boss') return res.status(403).json({ error: '只有老闆可再來一單' });
      const nr = await query(
        `INSERT INTO orders (boss_id, amount, product_name, scheduled_at, note, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
        [order.boss_id, order.amount, order.product_name, null, order.note]
      );
      await logOrder(nr.rows[0].id, userId, 'reorder', `from #${orderId}`);
      return res.json({ ok: true, newOrderId: nr.rows[0].id });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '操作失敗' });
  }
});

// 注意：已移除「放下訂單」功能（打手不可自行退回）

// ===== 列表 API =====
app.get('/api/orders/my', requireLogin, async (req, res) => {
  try {
    const role = req.session.role;
    let sql, params;
    if (role === 'boss') {
      sql = `SELECT o.*, u.name as player_name FROM orders o
             LEFT JOIN users u ON o.player_id = u.id
             WHERE o.boss_id = $1 ORDER BY o.created_at DESC LIMIT 50`;
      params = [req.session.userId];
    } else if (role === 'player') {
      sql = `SELECT o.*, b.name as boss_name FROM orders o
             LEFT JOIN users b ON o.boss_id = b.id
             WHERE o.player_id = $1 OR (o.status = 'pending' AND o.player_id IS NULL)
             ORDER BY o.is_urgent DESC, o.created_at DESC LIMIT 50`;
      params = [req.session.userId];
    } else {
      sql = `SELECT o.*, b.name as boss_name, p.name as player_name FROM orders o
             LEFT JOIN users b ON o.boss_id = b.id
             LEFT JOIN users p ON o.player_id = p.id
             ORDER BY o.created_at DESC LIMIT 100`;
      params = [];
    }
    const r = await query(sql, params);
    res.json({ orders: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '取得失敗' });
  }
});

// ===== 管理員頁面與 API =====
app.get('/admin', requireLogin, requireRole('admin'), async (req, res) => {
  res.render('admin', { title: '管理後台' });
});

app.get('/api/admin/pending-users', requireLogin, requireRole('admin'), async (req, res) => {
  const r = await query(`SELECT id, phone, name, created_at, verification_code FROM users WHERE status = 'pending' ORDER BY created_at`);
  res.json({ users: r.rows });
});

app.get('/api/admin/players', requireLogin, requireRole('admin'), async (req, res) => {
  const r = await query(`SELECT id, phone, name, status, created_at FROM users WHERE role = 'player' ORDER BY id`);
  res.json({ players: r.rows });
});

app.post('/api/admin/add-player', requireLogin, requireRole('admin'), async (req, res) => {
  try {
    const { phone, name, password } = req.body;
    if (!phone) return res.status(400).json({ error: '需要手機號' });
    const pass = password || '123456';
    const hash = await authLib.hashPassword(pass);
    const plainEnc = authLib.encryptPlain(pass);
    await query(
      `INSERT INTO users (phone, password_hash, password_plain, name, role, status)
       VALUES ($1, $2, $3, $4, 'player', 'active')
       ON CONFLICT (phone) DO NOTHING`,
      [phone, hash, plainEnc, name || phone]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/view-password/:id', requireLogin, requireRole('admin'), async (req, res) => {
  const r = await query('SELECT password_plain FROM users WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: '找不到' });
  const plain = authLib.decryptPlain(r.rows[0].password_plain);
  res.json({ password: plain || '(無法解密，請檢查 PASSWORD_VIEW_KEY)' });
});

app.get('/api/admin/stats', requireLogin, requireRole('admin'), async (req, res) => {
  const month = dayjs().format('YYYY-MM');
  const r = await query(
    `SELECT COUNT(*) as total_orders,
            COALESCE(SUM(amount),0) as total_amount,
            COALESCE(SUM(CASE WHEN status='completed' THEN amount ELSE 0 END),0) as completed_amount
     FROM orders WHERE to_char(created_at, 'YYYY-MM') = $1`,
    [month]
  );
  res.json({ month, ...r.rows[0] });
});

// ===== 老闆 / 打手頁面 =====
app.get('/boss', requireLogin, requireRole('boss'), (req, res) => {
  res.render('boss', { title: '我的訂單' });
});

app.get('/player', requireLogin, requireRole('player'), (req, res) => {
  res.render('player', { title: '打手工作台' });
});

// ===== 工具函式 =====
async function logOrder(orderId, userId, action, detail) {
  await query(
    `INSERT INTO order_logs (order_id, user_id, action, detail) VALUES ($1, $2, $3, $4)`,
    [orderId, userId, action, detail]
  );
}

async function sendWechatNotify(text) {
  const url = process.env.WECHAT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } })
    });
  } catch (e) {
    console.error('WeChat notify failed', e.message);
  }
}

// 定期清理過期截圖（簡單版，啟動時跑一次 + 每天）
async function cleanupOldScreenshots() {
  const days = parseInt(process.env.SCREENSHOT_RETENTION_DAYS || '90', 10);
  try {
    const r = await query(
      `SELECT id, screenshot_url FROM orders
       WHERE screenshot_url IS NOT NULL AND completed_at < NOW() - INTERVAL '${days} days'`
    );
    for (const row of r.rows) {
      if (row.screenshot_url && row.screenshot_url.startsWith('/uploads/')) {
        const fp = path.join(__dirname, 'public', row.screenshot_url);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      await query(`UPDATE orders SET screenshot_url = NULL WHERE id = $1`, [row.id]);
    }
    if (r.rows.length) console.log(`Cleaned ${r.rows.length} old screenshots`);
  } catch (e) {
    console.error('Cleanup error', e.message);
  }
}

// ===== 啟動 =====
async function start() {
  try {
    await initDb();
    console.log('Database ready');
    cleanupOldScreenshots();
    setInterval(cleanupOldScreenshots, 24 * 60 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`MaxClub running on http://localhost:${PORT}`);
      console.log('Admin phone:', process.env.ADMIN_PHONE || '0963696619');
    });
  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
}

start();
