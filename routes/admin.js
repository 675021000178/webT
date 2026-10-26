// ส่วน Admin แยกจากเว็บทั่วไป: /admin/...  (Users, Roles, Permissions, ACL matrix, Logs)
const bcrypt = require('bcryptjs');
const router = require('express').Router();
const pool = require('../db');
const audit = require('../lib/audit');
const catalog = require('../lib/catalog');
const { requireLogin, requirePerm, bad, text, idParam, validId } = require('../middleware');

const ADMIN_PERMS = ['admin.users', 'admin.roles', 'admin.permissions', 'admin.acl', 'logs.read'];
router.use(requireLogin, requirePerm(...ADMIN_PERMS));   // ชั้นแรก: ต้องมีสิทธิ์ส่วน Admin อย่างน้อย 1 อย่าง
router.param('id', idParam);

async function tx(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
const notFound = (res, what) => res.status(404).render('error', { title: 'ไม่พบข้อมูล', code: 404, message: 'ไม่พบ' + what + 'ที่ต้องการ' });

// ================= หน้าแรกส่วน Admin =================
router.get('/', async (req, res) => {
  const c = (await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM roles) AS roles,
    (SELECT COUNT(*)::int FROM permissions) AS perms,
    (SELECT COUNT(*)::int FROM audit_logs WHERE result='denied' AND created_at > NOW() - INTERVAL '24 hours') AS denied,
    (SELECT COUNT(*)::int FROM audit_logs WHERE event='login' AND result='failure' AND created_at > NOW() - INTERVAL '24 hours') AS failed_login`)).rows[0];
  const recent = req.can('logs.read')
    ? (await pool.query('SELECT * FROM audit_logs ORDER BY log_id DESC LIMIT 8')).rows : [];
  res.render('admin-home', { title: 'ส่วนผู้ดูแลระบบ', c, recent });
});

// ================= Users =================
const MIN_PW = 6;
function checkPassword(pw) {
  if (pw.length < MIN_PW || Buffer.byteLength(pw, 'utf8') > 72) bad('รหัสผ่านต้องยาวอย่างน้อย ' + MIN_PW + ' ตัวอักษร และไม่เกิน 72 ไบต์');
}
async function otherActiveSuperusers(c, exceptUserId) {
  const r = await c.query(`SELECT COUNT(*)::int n FROM users u JOIN roles r USING (role_id)
    WHERE r.is_superuser AND u.is_active AND u.user_id<>$1`, [exceptUserId]);
  return r.rows[0].n;
}
function userInput(body) {
  const u = { username: text(body.username), full_name: text(body.full_name),
    role_id: body.role_id, active: body.is_active === '1', password: String(body.password || '') };
  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(u.username)) bad('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, _ . - ยาว 3–50 ตัวอักษร');
  if (!u.full_name || u.full_name.length > 120) bad('กรุณาระบุชื่อ-นามสกุล (ไม่เกิน 120 ตัวอักษร)');
  if (!validId(u.role_id)) bad('กรุณาเลือก Role');
  u.role_id = Number(u.role_id);
  return u;
}

router.get('/users', requirePerm('admin.users'), async (req, res) => {
  const q = text(req.query.q).slice(0, 50);
  const args = [], w = q ? (args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%'),
    'WHERE u.username ILIKE $1 OR u.full_name ILIKE $1') : '';
  const rows = (await pool.query(`SELECT u.user_id,u.username,u.full_name,u.is_active,u.created_at,
    r.role_name, r.is_superuser FROM users u JOIN roles r USING (role_id) ${w} ORDER BY u.user_id`, args)).rows;
  res.render('admin-users', { title: 'จัดการผู้ใช้', rows, q });
});
async function roleChoices() { return (await pool.query('SELECT role_id, role_name, is_superuser FROM roles ORDER BY role_id')).rows; }

router.get('/users/new', requirePerm('admin.users'), async (req, res) => {
  res.render('admin-user-form', { title: 'เพิ่มผู้ใช้', row: null, roles: await roleChoices() });
});
router.post('/users', requirePerm('admin.users'), async (req, res) => {
  const u = userInput(req.body);
  checkPassword(u.password);
  const role = (await pool.query('SELECT * FROM roles WHERE role_id=$1', [u.role_id])).rows[0];
  if (!role) bad('ไม่พบ Role');
  if (role.is_superuser && !req.user.is_superuser) bad('เฉพาะ Admin เท่านั้นที่กำหนด Role ผู้ดูแลระบบได้', 403);
  const r = await pool.query(`INSERT INTO users (username,full_name,password_hash,role_id,is_active)
    VALUES ($1,$2,$3,$4,$5) RETURNING user_id`,
    [u.username, u.full_name, await bcrypt.hash(u.password, 10), u.role_id, u.active]);
  await audit(req, { event: 'user.create', resource: 'user', resourceId: r.rows[0].user_id, detail: u.username + ' role=' + role.role_name });
  req.flash('ok', 'เพิ่มผู้ใช้เรียบร้อย');
  res.redirect('/admin/users');
});
router.get('/users/:id/edit', requirePerm('admin.users'), async (req, res) => {
  const row = (await pool.query('SELECT user_id,username,full_name,role_id,is_active FROM users WHERE user_id=$1', [req.params.id])).rows[0];
  if (!row) return notFound(res, 'ผู้ใช้');
  res.render('admin-user-form', { title: 'แก้ไขผู้ใช้', row, roles: await roleChoices() });
});
router.post('/users/:id/update', requirePerm('admin.users'), async (req, res) => {
  const u = userInput(req.body);
  if (u.password) checkPassword(u.password);
  const changes = await tx(async c => {
    const old = (await c.query(`SELECT u.*, r.role_name, r.is_superuser FROM users u JOIN roles r USING (role_id)
      WHERE u.user_id=$1 FOR UPDATE OF u`, [req.params.id])).rows[0];
    if (!old) bad('ไม่พบผู้ใช้', 404);
    const role = (await c.query('SELECT * FROM roles WHERE role_id=$1', [u.role_id])).rows[0];
    if (!role) bad('ไม่พบ Role');
    if ((old.is_superuser || role.is_superuser) && !req.user.is_superuser && old.role_id !== role.role_id)
      bad('เฉพาะ Admin เท่านั้นที่เปลี่ยนบทบาทผู้ดูแลระบบได้', 403);
    if (old.is_superuser && !req.user.is_superuser) bad('เฉพาะ Admin เท่านั้นที่แก้ไขบัญชีผู้ดูแลระบบได้', 403);
    if (Number(req.params.id) === req.user.user_id && !u.active) bad('ไม่สามารถปิดใช้งานบัญชีของตนเองได้');
    // ป้องกันไม่ให้ระบบไม่มี Admin เหลืออยู่
    if (old.is_superuser && old.is_active && (!role.is_superuser || !u.active)
        && await otherActiveSuperusers(c, old.user_id) === 0)
      bad('ต้องมี Admin ที่ใช้งานได้อย่างน้อย 1 คนเสมอ จึงเปลี่ยน Role หรือปิดใช้งานบัญชีนี้ไม่ได้');
    if (u.password) {
      await c.query('UPDATE users SET username=$1,full_name=$2,role_id=$3,is_active=$4,password_hash=$5 WHERE user_id=$6',
        [u.username, u.full_name, u.role_id, u.active, await bcrypt.hash(u.password, 10), old.user_id]);
    } else {
      await c.query('UPDATE users SET username=$1,full_name=$2,role_id=$3,is_active=$4 WHERE user_id=$5',
        [u.username, u.full_name, u.role_id, u.active, old.user_id]);
    }
    return { old, role };
  });
  await audit(req, { event: 'user.update', resource: 'user', resourceId: req.params.id, detail: u.username + (u.password ? ' (เปลี่ยนรหัสผ่าน)' : '') });
  if (changes.old.role_id !== u.role_id)
    await audit(req, { event: 'user.role_change', resource: 'user', resourceId: req.params.id,
      detail: u.username + ': ' + changes.old.role_name + ' -> ' + changes.role.role_name });
  req.flash('ok', 'บันทึกข้อมูลผู้ใช้แล้ว');
  res.redirect('/admin/users');
});
router.post('/users/:id/delete', requirePerm('admin.users'), async (req, res) => {
  if (Number(req.params.id) === req.user.user_id) bad('ไม่สามารถลบบัญชีของตนเองได้');
  const name = await tx(async c => {
    const old = (await c.query(`SELECT u.*, r.is_superuser FROM users u JOIN roles r USING (role_id)
      WHERE u.user_id=$1 FOR UPDATE OF u`, [req.params.id])).rows[0];
    if (!old) bad('ไม่พบผู้ใช้', 404);
    if (old.is_superuser && !req.user.is_superuser) bad('เฉพาะ Admin เท่านั้นที่ลบบัญชีผู้ดูแลระบบได้', 403);
    if (old.is_superuser && old.is_active && await otherActiveSuperusers(c, old.user_id) === 0)
      bad('ต้องมี Admin ที่ใช้งานได้อย่างน้อย 1 คนเสมอ');
    const used = (await c.query('SELECT COUNT(*)::int n FROM loans WHERE user_id=$1 OR decided_by=$1 OR returned_to=$1', [old.user_id])).rows[0].n;
    if (used) bad('ผู้ใช้นี้มีประวัติการยืม ลบไม่ได้ ให้ปิดการใช้งาน (ไม่ใช้งาน) แทน');
    await c.query('DELETE FROM users WHERE user_id=$1', [old.user_id]);
    return old.username;
  });
  await audit(req, { event: 'user.delete', resource: 'user', resourceId: req.params.id, detail: name });
  req.flash('ok', 'ลบผู้ใช้แล้ว');
  res.redirect('/admin/users');
});

// ================= Roles =================
function roleInput(body) {
  const r = { name: text(body.role_name).toLowerCase(), description: text(body.description) };
  if (!/^[a-z0-9_]{2,50}$/.test(r.name)) bad('ชื่อ Role ใช้ a-z, 0-9 และ _ ยาว 2–50 ตัวอักษร (เช่น auditor)');
  if (r.description.length > 255) bad('คำอธิบายยาวเกินไป');
  return r;
}
router.get('/roles', requirePerm('admin.roles'), async (req, res) => {
  const rows = (await pool.query(`SELECT r.*,
      (SELECT COUNT(*)::int FROM users u WHERE u.role_id=r.role_id) AS users,
      (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id=r.role_id) AS perms
    FROM roles r ORDER BY r.role_id`)).rows;
  res.render('admin-roles', { title: 'จัดการ Role', rows });
});
router.get('/roles/new', requirePerm('admin.roles'), (req, res) => res.render('admin-role-form', { title: 'เพิ่ม Role', row: null }));
router.post('/roles', requirePerm('admin.roles'), async (req, res) => {
  const r = roleInput(req.body);
  const out = await pool.query('INSERT INTO roles (role_name, description) VALUES ($1,$2) RETURNING role_id', [r.name, r.description]);
  await audit(req, { event: 'role.create', resource: 'role', resourceId: out.rows[0].role_id, detail: r.name });
  req.flash('ok', 'เพิ่ม Role แล้ว ไปที่ "ตารางสิทธิ์ (ACL)" เพื่อกำหนด Permission ให้ Role นี้');
  res.redirect('/admin/roles');
});
router.get('/roles/:id/edit', requirePerm('admin.roles'), async (req, res) => {
  const row = (await pool.query('SELECT * FROM roles WHERE role_id=$1', [req.params.id])).rows[0];
  if (!row) return notFound(res, 'Role');
  res.render('admin-role-form', { title: 'แก้ไข Role', row });
});
router.post('/roles/:id/update', requirePerm('admin.roles'), async (req, res) => {
  const r = roleInput(req.body);
  const old = (await pool.query('SELECT * FROM roles WHERE role_id=$1', [req.params.id])).rows[0];
  if (!old) bad('ไม่พบ Role', 404);
  if (old.is_superuser && r.name !== old.role_name) bad('ไม่สามารถเปลี่ยนชื่อ Role ผู้ดูแลระบบได้');
  await pool.query('UPDATE roles SET role_name=$1, description=$2 WHERE role_id=$3', [r.name, r.description, old.role_id]);
  await audit(req, { event: 'role.update', resource: 'role', resourceId: old.role_id, detail: old.role_name + ' -> ' + r.name });
  req.flash('ok', 'บันทึกแล้ว');
  res.redirect('/admin/roles');
});
router.post('/roles/:id/delete', requirePerm('admin.roles'), async (req, res) => {
  const old = (await pool.query(`SELECT r.*, (SELECT COUNT(*)::int FROM users u WHERE u.role_id=r.role_id) AS users
    FROM roles r WHERE r.role_id=$1`, [req.params.id])).rows[0];
  if (!old) bad('ไม่พบ Role', 404);
  if (old.is_superuser) bad('ไม่สามารถลบ Role ผู้ดูแลระบบได้');
  if (old.users > 0) bad('ลบไม่ได้: Role "' + old.role_name + '" ยังมีผู้ใช้ ' + old.users + ' คน ให้ย้ายผู้ใช้ไป Role อื่นก่อน');
  await pool.query('DELETE FROM roles WHERE role_id=$1', [old.role_id]);   // ACL ของ Role นี้ถูกลบตาม (CASCADE)
  await audit(req, { event: 'role.delete', resource: 'role', resourceId: old.role_id, detail: old.role_name });
  req.flash('ok', 'ลบ Role แล้ว');
  res.redirect('/admin/roles');
});

// ================= Permissions =================
const PERM_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
function permInput(body) {
  const p = { name: text(body.permission_name).toLowerCase(), description: text(body.description) };
  if (p.name.length > 100 || !PERM_RE.test(p.name)) bad('ชื่อ Permission ต้องอยู่ในรูปแบบ resource.action เช่น books.export');
  if (p.description.length > 255) bad('คำอธิบายยาวเกินไป');
  return p;
}
router.get('/permissions', requirePerm('admin.permissions'), async (req, res) => {
  const rows = (await pool.query(`SELECT p.*, (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.permission_id=p.permission_id) AS roles
    FROM permissions p ORDER BY p.permission_name`)).rows;
  const guardMap = Object.fromEntries(catalog.map(c => [c.name, c.guard]));
  const have = new Set(rows.map(r => r.permission_name));
  res.render('admin-permissions', { title: 'จัดการ Permission', rows, guardMap, missing: catalog.filter(c => !have.has(c.name)) });
});
router.post('/permissions/register', requirePerm('admin.permissions'), async (req, res) => {
  const c = catalog.find(x => x.name === req.body.permission_name);
  if (!c) bad('ไม่พบ Permission นี้ในรายการที่ระบบรองรับ');
  await pool.query('INSERT INTO permissions (permission_name, description) VALUES ($1,$2)', [c.name, c.desc]);
  await audit(req, { event: 'permission.create', resource: 'permission', detail: c.name });
  req.flash('ok', 'เพิ่ม ' + c.name + ' แล้ว ไปกำหนดให้ Role ที่หน้า "ตารางสิทธิ์ (ACL)"');
  res.redirect('/admin/permissions');
});
router.get('/permissions/new', requirePerm('admin.permissions'), (req, res) => res.render('admin-permission-form', { title: 'เพิ่ม Permission', row: null }));
router.post('/permissions', requirePerm('admin.permissions'), async (req, res) => {
  const p = permInput(req.body);
  const r = await pool.query('INSERT INTO permissions (permission_name, description) VALUES ($1,$2) RETURNING permission_id', [p.name, p.description]);
  const bound = catalog.some(c => c.name === p.name);
  await audit(req, { event: 'permission.create', resource: 'permission', resourceId: r.rows[0].permission_id, detail: p.name });
  req.flash(bound ? 'ok' : 'warn', bound ? 'เพิ่ม Permission แล้ว'
    : 'เพิ่ม Permission แล้ว แต่ยังไม่มีโค้ดตรวจสิทธิ์ชื่อนี้ในระบบ จึงยังไม่ได้ป้องกันฟังก์ชันใด');
  res.redirect('/admin/permissions');
});
router.get('/permissions/:id/edit', requirePerm('admin.permissions'), async (req, res) => {
  const row = (await pool.query('SELECT * FROM permissions WHERE permission_id=$1', [req.params.id])).rows[0];
  if (!row) return notFound(res, 'Permission');
  res.render('admin-permission-form', { title: 'แก้ไข Permission', row });
});
router.post('/permissions/:id/update', requirePerm('admin.permissions'), async (req, res) => {
  const p = permInput(req.body);
  const old = (await pool.query('SELECT * FROM permissions WHERE permission_id=$1', [req.params.id])).rows[0];
  if (!old) bad('ไม่พบ Permission', 404);
  await pool.query('UPDATE permissions SET permission_name=$1, description=$2 WHERE permission_id=$3', [p.name, p.description, old.permission_id]);
  await audit(req, { event: 'permission.update', resource: 'permission', resourceId: old.permission_id, detail: old.permission_name + ' -> ' + p.name });
  req.flash('ok', 'บันทึกแล้ว');
  res.redirect('/admin/permissions');
});
router.post('/permissions/:id/delete', requirePerm('admin.permissions'), async (req, res) => {
  const old = (await pool.query(`SELECT p.*, (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.permission_id=p.permission_id) AS roles
    FROM permissions p WHERE p.permission_id=$1`, [req.params.id])).rows[0];
  if (!old) bad('ไม่พบ Permission', 404);
  await pool.query('DELETE FROM permissions WHERE permission_id=$1', [old.permission_id]);  // ถอนจากทุก Role ตาม (CASCADE)
  await audit(req, { event: 'permission.delete', resource: 'permission', resourceId: old.permission_id,
    detail: old.permission_name + ' (ถอนจาก ' + old.roles + ' Role)' });
  req.flash('ok', 'ลบ Permission แล้ว (ถอนออกจาก ' + old.roles + ' Role)');
  res.redirect('/admin/permissions');
});

// ================= ACL: ตาราง Role x Permission =================
router.get('/acl', requirePerm('admin.acl'), async (req, res) => {
  const roles = (await pool.query('SELECT * FROM roles ORDER BY role_id')).rows;
  const perms = (await pool.query('SELECT * FROM permissions ORDER BY permission_name')).rows;
  const granted = new Set((await pool.query('SELECT role_id, permission_id FROM role_permissions')).rows
    .map(r => r.role_id + ':' + r.permission_id));
  const bound = new Set(catalog.map(c => c.name));
  res.render('admin-acl', { title: 'ตารางสิทธิ์ (ACL)', roles, perms, granted, bound });
});
router.post('/acl', requirePerm('admin.acl'), async (req, res) => {
  const want = new Set([].concat(req.body.grant || []).map(String));
  for (const g of want) { const [a, b] = g.split(':'); if (!validId(a) || !validId(b)) bad('ข้อมูลตารางสิทธิ์ไม่ถูกต้อง'); }
  const result = await tx(async c => {
    const roles = (await c.query('SELECT * FROM roles ORDER BY role_id')).rows;
    const perms = (await c.query('SELECT * FROM permissions')).rows;
    const cur = new Set((await c.query('SELECT role_id, permission_id FROM role_permissions')).rows.map(r => r.role_id + ':' + r.permission_id));
    const log = [];
    for (const r of roles) {
      if (r.is_superuser) continue;                              // Admin ทำได้ทุกอย่าง ไม่เก็บใน ACL
      for (const p of perms) {
        const k = r.role_id + ':' + p.permission_id;
        if (want.has(k) === cur.has(k)) continue;
        if (r.role_id === req.user.role_id && !req.user.is_superuser) bad('ไม่สามารถแก้สิทธิ์ของ Role ตนเองได้', 403);
        if (want.has(k)) await c.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)', [r.role_id, p.permission_id]);
        else await c.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=$2', [r.role_id, p.permission_id]);
        log.push({ event: want.has(k) ? 'acl.grant' : 'acl.revoke', resourceId: r.role_id, detail: r.role_name + ' : ' + p.permission_name });
      }
    }
    return log;
  });
  for (const l of result) await audit(req, { ...l, resource: 'role' });
  req.flash('ok', result.length ? 'บันทึกสิทธิ์แล้ว (เปลี่ยน ' + result.length + ' รายการ) มีผลทันที' : 'ไม่มีการเปลี่ยนแปลง');
  res.redirect('/admin/acl');
});

// ================= Log ย้อนหลัง =================
router.get('/logs', requirePerm('logs.read'), async (req, res) => {
  const f = { from: text(req.query.from), to: text(req.query.to), user: text(req.query.user).slice(0, 50),
    event: text(req.query.event).slice(0, 60), result: text(req.query.result), q: text(req.query.q).slice(0, 100) };
  const dateRe = /^\d{4}-\d{2}-\d{2}$/, where = [], args = [];
  if (dateRe.test(f.from)) { args.push(f.from); where.push(`created_at >= ($${args.length}::date::timestamp AT TIME ZONE 'Asia/Bangkok')`); }
  if (dateRe.test(f.to)) { args.push(f.to); where.push(`created_at < (($${args.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`); }
  if (f.user) { args.push('%' + f.user.replace(/[%_\\]/g, '\\$&') + '%'); where.push(`username ILIKE $${args.length}`); }
  if (f.event) { args.push(f.event); where.push(`event=$${args.length}`); }
  if (['success', 'failure', 'denied'].includes(f.result)) { args.push(f.result); where.push(`result=$${args.length}`); }
  if (f.q) { args.push('%' + f.q.replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(detail ILIKE $${args.length} OR resource ILIKE $${args.length})`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await pool.query(`SELECT COUNT(*)::int n FROM audit_logs ${w}`, args)).rows[0].n;
  const SIZE = 30, pages = Math.max(1, Math.ceil(total / SIZE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const rows = (await pool.query(`SELECT * FROM audit_logs ${w} ORDER BY log_id DESC LIMIT ${SIZE} OFFSET ${(page - 1) * SIZE}`, args)).rows;
  const events = (await pool.query('SELECT DISTINCT event FROM audit_logs ORDER BY event')).rows.map(r => r.event);
  res.locals.pg = { page, pages, total };
  res.locals.pageUrl = p => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
    q.set('page', p); return '?' + q.toString();
  };
  res.render('admin-logs', { title: 'Log การใช้งาน', rows, events, f });
});
module.exports = router;
