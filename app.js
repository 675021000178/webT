const path = require('node:path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('./db');
const audit = require('./lib/audit');
const { loadUser, requireLogin, csrf, flash, text } = require('./middleware');

if (!process.env.SESSION_SECRET) throw new Error('กรุณาตั้ง SESSION_SECRET ในไฟล์ .env');

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {            // Security headers พื้นฐาน
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }),   // Session เก็บใน PostgreSQL
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 1000 }
}));
app.use((req, res, next) => { req.body = req.body || {}; next(); });
app.use(loadUser);
// ---------- ตัวช่วยแสดงผลใน View ----------
const dtf = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok',
  dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' });
app.use((req, res, next) => {
  res.locals.fmt = d => d ? dtf.format(new Date(d)) : '-';
  res.locals.fmtDate = d => d ? df.format(new Date(d)) : '-';
  const here = req.path;
  res.locals.path = here;
  res.locals.active = prefix => (here === prefix || here.startsWith(prefix + '/')) ? 'active' : '';
  res.locals.statusText = { pending: 'รออนุมัติ', approved: 'กำลังยืม', rejected: 'ปฏิเสธ',
    returned: 'คืนแล้ว', cancelled: 'ยกเลิก' };
  next();
});

app.use(flash);
app.use(csrf);

// ---------- Login / Logout ----------
const fails = new Map();                       // กัน Brute force อย่างง่าย: 5 ครั้ง / 10 นาที
const WINDOW = 10 * 60 * 1000, MAX_FAILS = 5;
function failState(key) {
  const f = fails.get(key);
  if (f && Date.now() - f.first > WINDOW) { fails.delete(key); return null; }
  return f || null;
}

app.get('/', (req, res) => res.redirect(req.user ? '/app' : '/login'));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/app');
  res.render('login', { error: '', username: '' });
});

app.post('/login', async (req, res, next) => {
  const username = text(req.body.username).slice(0, 50);
  const password = String(req.body.password || '');
  const key = req.ip + '|' + username.toLowerCase();
  const f = failState(key);
  if (f && f.count >= MAX_FAILS) {
    await audit(req, { event: 'login', result: 'failure', username, detail: 'ถูกจำกัดชั่วคราว (ลองผิดหลายครั้ง)' });
    return res.status(429).render('login', { username,
      error: 'ลองผิดหลายครั้งเกินไป กรุณารอ 10 นาทีแล้วลองใหม่' });
  }
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = r.rows[0];
  // เทียบ hash ด้วย bcrypt (ไม่มีผู้ใช้ก็เทียบกับ hash หลอก เพื่อให้เวลาตอบใกล้เคียงกัน)
  const dummy = '$2b$10$azzTM/caNNVWpXOgkFDFTeyoFSs03UEc/oswjcrtvAzIXpPil.FW6';
  const ok = await bcrypt.compare(password, user ? user.password_hash : dummy);
  if (!user || !ok || !user.is_active) {
    const cur = failState(key) || { count: 0, first: Date.now() };
    cur.count++; fails.set(key, cur);
    await audit(req, { event: 'login', result: 'failure', username,
      detail: !user ? 'ไม่พบบัญชี' : (!user.is_active ? 'บัญชีถูกปิดใช้งาน' : 'รหัสผ่านไม่ถูกต้อง') });
    return res.status(401).render('login', { username,
      error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  fails.delete(key);
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.userId = user.user_id;
    req.session.save(async err2 => {
      if (err2) return next(err2);
      await audit(req, { event: 'login', userId: user.user_id, username: user.username, detail: 'เข้าสู่ระบบสำเร็จ' });
      res.redirect('/app');
    });
  });
});

app.post('/logout', requireLogin, async (req, res) => {
  await audit(req, { event: 'logout' });
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// ---------- Route กลุ่มต่าง ๆ ----------
app.use('/app', require('./routes/library'));       // ส่วนผู้ใช้ทั่วไป
app.use('/files', require('./routes/files'));       // ไฟล์ (ตรวจสิทธิ์ก่อนส่ง)
app.use('/admin', require('./routes/admin'));       // ส่วน Admin
app.use('/api', require('./routes/api'));           // JSON API

app.use((req, res) => {
  if (req.originalUrl.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).render('error', { title: 'ไม่พบหน้า', code: 404, message: 'ไม่พบหน้าที่ต้องการ' });
});

app.use((err, req, res, next) => {
  const known = {
    '23505': 'ข้อมูลซ้ำ มีรายการนี้อยู่แล้ว',
    '23503': 'ข้อมูลนี้ยังถูกใช้งานอยู่ จึงลบหรือเปลี่ยนไม่ได้',
    '23502': 'ข้อมูลที่จำเป็นไม่ครบ',
    '23514': 'ค่าที่ระบุไม่ถูกต้องตามเงื่อนไข',
    '22P02': 'รูปแบบข้อมูลไม่ถูกต้อง'
  };
  if (!err.status) console.error(err);
  const status = known[err.code] ? 400 : (err.status || 500);
  const message = known[err.code] || (err.status ? err.message : 'เกิดข้อผิดพลาดภายในระบบ');
  if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: message });
  if (res.headersSent) return next(err);
  res.status(status).render('error', { title: 'เกิดข้อผิดพลาด', code: status, message });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '127.0.0.1', () => console.log('เปิด http://localhost:' + port + '/login'));
}
module.exports = app;
