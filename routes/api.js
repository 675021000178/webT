// JSON API (ใช้ Session เดียวกัน) — ตรวจสิทธิ์ฝั่ง Server ทุก endpoint
// /api/app/...   สำหรับผู้ใช้ทั่วไป
// /api/admin/... สำหรับ Admin
const router = require('express').Router();
const pool = require('../db');
const { requireLogin, requirePerm } = require('../middleware');

router.use(requireLogin);

const lim = (v, d = 50) => Math.min(Math.max(parseInt(v, 10) || d, 1), 200);
const off = v => Math.max(parseInt(v, 10) || 0, 0);

router.get('/me', (req, res) => {
  const u = req.user;
  res.json({ username: u.username, full_name: u.full_name, role: u.role_name,
    is_superuser: u.is_superuser, permissions: u.is_superuser ? ['*'] : [...u.perms].sort() });
});

router.get('/app/books', requirePerm('books.read'), async (req, res) => {
  const r = await pool.query('SELECT book_id,isbn,title,author,category,total_copies,available_copies FROM books ORDER BY title LIMIT $1 OFFSET $2',
    [lim(req.query.limit), off(req.query.offset)]);
  res.json({ data: r.rows });
});

router.get('/app/loans', requirePerm('loans.read.all', 'loans.read.own'), async (req, res) => {
  const all = req.can('loans.read.all');
  const r = await pool.query(`SELECT l.loan_id, l.status, l.requested_at, l.due_date, l.returned_at, b.title, u.username
    FROM loans l JOIN books b USING (book_id) JOIN users u ON u.user_id=l.user_id
    ${all ? '' : 'WHERE l.user_id=$3'} ORDER BY l.loan_id DESC LIMIT $1 OFFSET $2`,
    all ? [lim(req.query.limit), off(req.query.offset)] : [lim(req.query.limit), off(req.query.offset), req.user.user_id]);
  res.json({ scope: all ? 'all' : 'own', data: r.rows });
});

router.get('/admin/users', requirePerm('admin.users'), async (req, res) => {
  const r = await pool.query(`SELECT u.user_id,u.username,u.full_name,u.is_active,r.role_name
    FROM users u JOIN roles r USING (role_id) ORDER BY u.user_id`);
  res.json({ data: r.rows });                    // ไม่ส่ง password_hash
});
router.get('/admin/roles', requirePerm('admin.roles'), async (req, res) => {
  const r = await pool.query(`SELECT r.role_id, r.role_name, r.description, r.is_superuser,
    COALESCE(array_agg(p.permission_name ORDER BY p.permission_name) FILTER (WHERE p.permission_name IS NOT NULL), '{}') AS permissions
    FROM roles r LEFT JOIN role_permissions rp USING (role_id) LEFT JOIN permissions p USING (permission_id)
    GROUP BY r.role_id ORDER BY r.role_id`);
  res.json({ data: r.rows });
});
router.get('/admin/logs', requirePerm('logs.read'), async (req, res) => {
  const r = await pool.query('SELECT * FROM audit_logs ORDER BY log_id DESC LIMIT $1 OFFSET $2', [lim(req.query.limit), off(req.query.offset)]);
  res.json({ data: r.rows });
});

module.exports = router;
