const crypto = require('node:crypto');
const pool = require('./db');
const audit = require('./lib/audit');

const wantsJson = req => req.originalUrl.startsWith('/api/');

// ---------- โหลดผู้ใช้ + สิทธิ์จากฐานข้อมูลทุกคำขอ (เปลี่ยนสิทธิ์แล้วมีผลทันที ไม่ต้องรีสตาร์ต) ----------
async function loadUser(req, res, next) {
  req.user = null;
  const id = req.session && req.session.userId;
  if (id) {
    const r = await pool.query(
      `SELECT u.user_id, u.username, u.full_name, u.is_active, u.role_id,
              r.role_name, r.is_superuser
       FROM users u JOIN roles r USING (role_id) WHERE u.user_id=$1`, [id]);
    const u = r.rows[0];
    if (u && u.is_active) {
      const p = await pool.query(
        `SELECT p.permission_name FROM role_permissions rp
         JOIN permissions p USING (permission_id) WHERE rp.role_id=$1`, [u.role_id]);
      u.perms = new Set(p.rows.map(x => x.permission_name));
      req.user = u;
    } else {
      // บัญชีถูกลบ/ปิดใช้งาน -> ตัด Session ทันที
      await new Promise(done => req.session.destroy(done));
    }
  }
  const user = req.user;
  res.locals.me = user;
  // can(): Admin (superuser) ผ่านทุกสิทธิ์ รวมถึง Permission ที่เพิ่มภายหลัง
  res.locals.can = name => !!user && (user.is_superuser || user.perms.has(name));
  req.can = res.locals.can;
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Unauthorized: please login' });
  res.redirect('/login');
}

async function deny(req, res, need) {
  await audit(req, { event: 'access.denied', resource: req.method + ' ' + req.originalUrl.split('?')[0],
    result: 'denied', detail: 'ต้องมีสิทธิ์: ' + need });
  if (wantsJson(req)) return res.status(403).json({ error: 'Forbidden', required: need });
  res.status(403).render('error', { title: 'ไม่มีสิทธิ์เข้าถึง', code: 403,
    message: 'บัญชีของคุณไม่มีสิทธิ์ทำรายการนี้ (' + need + ')' });
}

// ต้องมีอย่างน้อย 1 สิทธิ์ในรายการ
function requirePerm(...names) {
  return async (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (names.some(n => req.can(n))) return next();
    await deny(req, res, names.join(' หรือ '));
  };
}

// ---------- CSRF (token ต่อ Session) ----------
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST') {
    const sent = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
    if (sent !== req.session.csrf) {
      return res.status(403).render('error', { title: 'คำขอไม่ถูกต้อง', code: 403,
        message: 'Token ของฟอร์มไม่ถูกต้องหรือหมดอายุ กรุณากลับไปโหลดหน้าใหม่แล้วลองอีกครั้ง' });
    }
  }
  next();
}

// ---------- Flash message ----------
function flash(req, res, next) {
  req.flash = (type, msg) => {
    req.session.flashes = req.session.flashes || [];
    req.session.flashes.push({ type, msg });
  };
  res.locals.flashes = req.session.flashes || [];
  req.session.flashes = [];
  next();
}

// ---------- ตัวช่วยตรวจข้อมูล ----------
function validId(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
}
function bad(message, status = 400) {
  const err = new Error(message); err.status = status; throw err;
}
function text(v) { return String(v ?? '').trim(); }
function idParam(req, res, next, id) {
  if (!validId(id)) return res.status(400).render('error', { title: 'ข้อมูลไม่ถูกต้อง', code: 400, message: 'รหัสอ้างอิง (ID) ไม่ถูกต้อง' });
  next();
}

module.exports = { deny, loadUser, requireLogin, requirePerm, csrf, flash, validId, bad, text, idParam, wantsJson };
