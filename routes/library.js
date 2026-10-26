// ส่วนผู้ใช้ทั่วไป: /app/...  (แดชบอร์ด, หนังสือ, คำขอยืม)
const fs = require('node:fs/promises');
const path = require('node:path');
const router = require('express').Router();
const pool = require('../db');
const audit = require('../lib/audit');
const { requireLogin, requirePerm, deny, bad, text, idParam } = require('../middleware');

const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads');
const MAX_ACTIVE_LOANS = 3;
const PAGE_SIZE = 12;

router.use(requireLogin);
router.param('id', idParam);

async function tx(fn) {                       // Transaction helper
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}
function pager(req, res, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  res.locals.pg = { page, pages, total };
  res.locals.pageUrl = p => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (k !== 'page' && typeof v === 'string' && v) q.set(k, v);
    q.set('page', p);
    return '?' + q.toString();
  };
  return { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
}

// ================= แดชบอร์ด =================
router.get('/', async (req, res) => {
  const d = { books: null, mine: null, pending: null, overdue: null, recent: [], queue: [] };
  if (req.can('books.read')) {
    const r = await pool.query('SELECT COUNT(*)::int n, COALESCE(SUM(available_copies),0)::int av FROM books');
    d.books = r.rows[0];
  }
  if (req.can('loans.read.own')) {
    const r = await pool.query(`SELECT
        COUNT(*) FILTER (WHERE status IN ('pending','approved'))::int AS active,
        COUNT(*) FILTER (WHERE status='approved' AND due_date < CURRENT_DATE)::int AS overdue
      FROM loans WHERE user_id=$1`, [req.user.user_id]);
    d.mine = r.rows[0];
    d.recent = (await pool.query(`SELECT l.*, b.title FROM loans l JOIN books b USING (book_id)
      WHERE l.user_id=$1 ORDER BY l.requested_at DESC LIMIT 5`, [req.user.user_id])).rows;
  }
  if (req.can('loans.read.all')) {
    const r = await pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE status='approved')::int AS borrowed,
        COUNT(*) FILTER (WHERE status='approved' AND due_date < CURRENT_DATE)::int AS overdue
      FROM loans`);
    d.all = r.rows[0];
    d.queue = (await pool.query(`SELECT l.*, b.title, u.full_name FROM loans l
      JOIN books b USING (book_id) JOIN users u ON u.user_id=l.user_id
      WHERE l.status='pending' ORDER BY l.requested_at LIMIT 5`)).rows;
  }
  res.render('dashboard', { title: 'แดชบอร์ด', d });
});

// ================= หนังสือ =================
router.get('/books', requirePerm('books.read'), async (req, res) => {
  const q = text(req.query.q).slice(0, 100);
  const cat = text(req.query.category).slice(0, 100);
  const onlyAvail = req.query.avail === '1';
  const where = [], args = [];
  if (q) { args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    where.push(`(b.title ILIKE $${args.length} OR b.author ILIKE $${args.length} OR b.isbn ILIKE $${args.length})`); }
  if (cat) { args.push(cat); where.push(`b.category=$${args.length}`); }
  if (onlyAvail) where.push('b.available_copies > 0');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await pool.query(`SELECT COUNT(*)::int n FROM books b ${w}`, args)).rows[0].n;
  const { limit, offset } = pager(req, res, total);
  const rows = (await pool.query(
    `SELECT b.*, (SELECT f.file_id FROM book_files f WHERE f.book_id=b.book_id
        AND f.mime_type LIKE 'image/%' ORDER BY f.file_id LIMIT 1) AS cover_id
     FROM books b ${w} ORDER BY b.title LIMIT ${limit} OFFSET ${offset}`, args)).rows;
  const cats = (await pool.query('SELECT DISTINCT category FROM books ORDER BY category')).rows;
  res.render('books-list', { title: 'หนังสือ', rows, cats, q, cat, onlyAvail });
});

function bookInput(body) {
  const b = {
    isbn: text(body.isbn).slice(0, 20),
    title: text(body.title), author: text(body.author),
    category: text(body.category) || 'ทั่วไป',
    description: text(body.description),
    total: Number(body.total_copies)
  };
  if (!b.title || b.title.length > 255) bad('กรุณาระบุชื่อหนังสือ (ไม่เกิน 255 ตัวอักษร)');
  if (!b.author || b.author.length > 255) bad('กรุณาระบุผู้แต่ง (ไม่เกิน 255 ตัวอักษร)');
  if (b.category.length > 100) bad('หมวดหมู่ยาวเกินไป');
  if (b.description.length > 2000) bad('คำอธิบายยาวเกินไป (ไม่เกิน 2000 ตัวอักษร)');
  if (!Number.isInteger(b.total) || b.total < 0 || b.total > 9999) bad('จำนวนเล่มต้องเป็นจำนวนเต็ม 0–9999');
  return b;
}

router.get('/books/export.csv', requirePerm('books.export'), async (req, res) => {
  const rows = (await pool.query('SELECT * FROM books ORDER BY book_id')).rows;
  const esc = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;                 // กัน CSV/Excel formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const head = ['book_id', 'isbn', 'title', 'author', 'category', 'total_copies', 'available_copies'];
  const csv = '\uFEFF' + [head.join(',')].concat(
    rows.map(r => head.map(h => esc(r[h])).join(','))).join('\r\n');
  await audit(req, { event: 'books.export', resource: 'books', detail: rows.length + ' แถว' });
  res.type('text/csv; charset=utf-8').attachment('books.csv').send(csv);
});

router.get('/books/new', requirePerm('books.create'), (req, res) => {
  res.render('book-form', { title: 'เพิ่มหนังสือ', row: null });
});

router.post('/books', requirePerm('books.create'), async (req, res) => {
  const b = bookInput(req.body);
  const r = await pool.query(
    `INSERT INTO books (isbn,title,author,category,description,total_copies,available_copies)
     VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING book_id`,
    [b.isbn || null, b.title, b.author, b.category, b.description, b.total]);
  await audit(req, { event: 'book.create', resource: 'book', resourceId: r.rows[0].book_id, detail: b.title });
  req.flash('ok', 'เพิ่มหนังสือเรียบร้อย');
  res.redirect('/app/books/' + r.rows[0].book_id);
});

router.get('/books/:id', requirePerm('books.read'), async (req, res) => {
  const book = (await pool.query('SELECT * FROM books WHERE book_id=$1', [req.params.id])).rows[0];
  if (!book) return res.status(404).render('error', { title: 'ไม่พบหนังสือ', code: 404, message: 'ไม่พบหนังสือที่ต้องการ' });
  const files = req.can('files.read') ? (await pool.query(
    `SELECT f.*, u.full_name AS uploader FROM book_files f
     LEFT JOIN users u ON u.user_id=f.uploaded_by WHERE f.book_id=$1 ORDER BY f.file_id`, [book.book_id])).rows : [];
  const mine = (await pool.query(
    `SELECT status FROM loans WHERE book_id=$1 AND user_id=$2 AND status IN ('pending','approved') LIMIT 1`,
    [book.book_id, req.user.user_id])).rows[0];
  res.render('book-detail', { title: book.title, book, files, mine });
});

router.get('/books/:id/edit', requirePerm('books.update'), async (req, res) => {
  const row = (await pool.query('SELECT * FROM books WHERE book_id=$1', [req.params.id])).rows[0];
  if (!row) return res.status(404).render('error', { title: 'ไม่พบหนังสือ', code: 404, message: 'ไม่พบหนังสือที่ต้องการ' });
  res.render('book-form', { title: 'แก้ไขหนังสือ', row });
});

router.post('/books/:id/update', requirePerm('books.update'), async (req, res) => {
  const b = bookInput(req.body);
  await tx(async c => {
    const old = (await c.query('SELECT * FROM books WHERE book_id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!old) bad('ไม่พบหนังสือ', 404);
    const avail = old.available_copies + (b.total - old.total_copies);
    if (avail < 0) bad('จำนวนเล่มทั้งหมดน้อยกว่าจำนวนที่กำลังถูกยืมอยู่ (' + (old.total_copies - old.available_copies) + ' เล่ม)');
    await c.query(`UPDATE books SET isbn=$1,title=$2,author=$3,category=$4,description=$5,
      total_copies=$6, available_copies=$7 WHERE book_id=$8`,
      [b.isbn || null, b.title, b.author, b.category, b.description, b.total, avail, req.params.id]);
  });
  await audit(req, { event: 'book.update', resource: 'book', resourceId: req.params.id, detail: b.title });
  req.flash('ok', 'บันทึกการแก้ไขแล้ว');
  res.redirect('/app/books/' + req.params.id);
});

router.post('/books/:id/delete', requirePerm('books.delete'), async (req, res) => {
  const used = (await pool.query('SELECT COUNT(*)::int n FROM loans WHERE book_id=$1', [req.params.id])).rows[0].n;
  if (used) bad('หนังสือเล่มนี้มีประวัติการยืม จึงลบไม่ได้ (ให้แก้จำนวนเล่มแทน)');
  const files = (await pool.query('SELECT stored_name FROM book_files WHERE book_id=$1', [req.params.id])).rows;
  const r = await pool.query('DELETE FROM books WHERE book_id=$1 RETURNING title', [req.params.id]);
  if (!r.rowCount) bad('ไม่พบหนังสือ', 404);
  for (const f of files) await fs.unlink(path.join(UPLOAD_DIR, f.stored_name)).catch(() => {});
  await audit(req, { event: 'book.delete', resource: 'book', resourceId: req.params.id, detail: r.rows[0].title });
  req.flash('ok', 'ลบหนังสือแล้ว');
  res.redirect('/app/books');
});

// ================= คำขอยืม (ส่งคำขอ → พิจารณา → อนุมัติ/ปฏิเสธ → คืน) =================
router.post('/books/:id/request', requirePerm('loans.create'), async (req, res) => {
  const note = text(req.body.note).slice(0, 500);
  const loanId = await tx(async c => {
    const book = (await c.query('SELECT * FROM books WHERE book_id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!book) bad('ไม่พบหนังสือ', 404);
    if (book.available_copies < 1) bad('ขณะนี้หนังสือเล่มนี้ไม่มีเล่มว่าง');
    const act = (await c.query(
      `SELECT book_id FROM loans WHERE user_id=$1 AND status IN ('pending','approved')`, [req.user.user_id])).rows;
    if (act.some(a => a.book_id === book.book_id)) bad('คุณมีคำขอหรือกำลังยืมหนังสือเล่มนี้อยู่แล้ว');
    if (act.length >= MAX_ACTIVE_LOANS) bad('ยืมและรออนุมัติรวมได้ไม่เกิน ' + MAX_ACTIVE_LOANS + ' รายการ');
    const r = await c.query(`INSERT INTO loans (book_id,user_id,note) VALUES ($1,$2,$3) RETURNING loan_id`,
      [book.book_id, req.user.user_id, note]);
    return r.rows[0].loan_id;
  });
  await audit(req, { event: 'loan.request', resource: 'loan', resourceId: loanId, detail: 'book_id=' + req.params.id });
  req.flash('ok', 'ส่งคำขอยืมแล้ว รอเจ้าหน้าที่พิจารณา');
  res.redirect('/app/loans/' + loanId);
});

const LOAN_SELECT = `SELECT l.*, b.title, b.author, u.username, u.full_name,
    d.full_name AS decider, rt.full_name AS receiver,
    (l.status='approved' AND l.due_date < CURRENT_DATE) AS overdue
  FROM loans l JOIN books b USING (book_id) JOIN users u ON u.user_id=l.user_id
  LEFT JOIN users d ON d.user_id=l.decided_by LEFT JOIN users rt ON rt.user_id=l.returned_to`;

router.get('/loans', requirePerm('loans.read.all', 'loans.read.own'), async (req, res) => {
  const all = req.can('loans.read.all');
  const status = ['pending', 'approved', 'rejected', 'returned', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const q = text(req.query.q).slice(0, 100);
  const where = [], args = [];
  if (!all) { args.push(req.user.user_id); where.push(`l.user_id=$${args.length}`); }
  if (status) { args.push(status); where.push(`l.status=$${args.length}`); }
  if (q && all) { args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    where.push(`(b.title ILIKE $${args.length} OR u.username ILIKE $${args.length} OR u.full_name ILIKE $${args.length})`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await pool.query(
    `SELECT COUNT(*)::int n FROM loans l JOIN books b USING (book_id) JOIN users u ON u.user_id=l.user_id ${w}`, args)).rows[0].n;
  const { limit, offset } = pager(req, res, total);
  const rows = (await pool.query(`${LOAN_SELECT} ${w}
    ORDER BY (l.status='pending') DESC, l.requested_at DESC LIMIT ${limit} OFFSET ${offset}`, args)).rows;
  res.render('loans-list', { title: all ? 'คำขอยืมทั้งหมด' : 'รายการยืมของฉัน', rows, all, status, q });
});

// ดึงรายการยืม + ตรวจเงื่อนไขเจ้าของข้อมูล (ผู้ใช้ทั่วไปดูได้เฉพาะของตน)
async function loadLoan(req, res) {
  const loan = (await pool.query(`${LOAN_SELECT} WHERE l.loan_id=$1`, [req.params.id])).rows[0];
  if (!loan) { res.status(404).render('error', { title: 'ไม่พบรายการ', code: 404, message: 'ไม่พบรายการยืมที่ต้องการ' }); return null; }
  if (!req.can('loans.read.all') && loan.user_id !== req.user.user_id) {
    await deny(req, res, 'ดูได้เฉพาะรายการของตนเอง'); return null;
  }
  return loan;
}

router.get('/loans/:id', requirePerm('loans.read.all', 'loans.read.own'), async (req, res) => {
  const loan = await loadLoan(req, res);
  if (loan) res.render('loan-detail', { title: 'รายการยืม #' + loan.loan_id, loan });
});

router.post('/loans/:id/cancel', requirePerm('loans.cancel.own'), async (req, res) => {
  const l = (await pool.query('SELECT * FROM loans WHERE loan_id=$1', [req.params.id])).rows[0];
  if (!l) bad('ไม่พบรายการ', 404);
  if (l.user_id !== req.user.user_id) return deny(req, res, 'ยกเลิกได้เฉพาะคำขอของตนเอง');
  const r = await pool.query(`UPDATE loans SET status='cancelled' WHERE loan_id=$1 AND status='pending'`, [l.loan_id]);
  if (!r.rowCount) bad('ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติ');
  await audit(req, { event: 'loan.cancel', resource: 'loan', resourceId: l.loan_id });
  req.flash('ok', 'ยกเลิกคำขอแล้ว');
  res.redirect('/app/loans');
});

router.post('/loans/:id/approve', requirePerm('loans.approve'), async (req, res) => {
  const days = Number(req.body.days || 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) bad('ระยะเวลายืมต้องอยู่ระหว่าง 1–30 วัน');
  const note = text(req.body.note).slice(0, 500);
  await tx(async c => {
    const l = (await c.query('SELECT * FROM loans WHERE loan_id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!l) bad('ไม่พบรายการ', 404);
    if (l.status !== 'pending') bad('รายการนี้ถูกพิจารณาไปแล้ว');
    if (l.user_id === req.user.user_id) bad('ไม่สามารถอนุมัติคำขอของตนเองได้');
    const b = (await c.query('SELECT * FROM books WHERE book_id=$1 FOR UPDATE', [l.book_id])).rows[0];
    if (b.available_copies < 1) bad('ไม่มีเล่มว่างสำหรับอนุมัติ');
    await c.query('UPDATE books SET available_copies=available_copies-1 WHERE book_id=$1', [b.book_id]);
    await c.query(`UPDATE loans SET status='approved', decided_by=$2, decided_at=NOW(),
      decision_note=$3, due_date=CURRENT_DATE+$4::int WHERE loan_id=$1`,
      [l.loan_id, req.user.user_id, note, days]);
  });
  await audit(req, { event: 'loan.approve', resource: 'loan', resourceId: req.params.id, detail: 'ยืม ' + days + ' วัน' });
  req.flash('ok', 'อนุมัติคำขอแล้ว');
  res.redirect('/app/loans/' + req.params.id);
});

router.post('/loans/:id/reject', requirePerm('loans.approve'), async (req, res) => {
  const note = text(req.body.note).slice(0, 500);
  const r = await pool.query(`UPDATE loans SET status='rejected', decided_by=$2, decided_at=NOW(), decision_note=$3
    WHERE loan_id=$1 AND status='pending' AND user_id<>$2`, [req.params.id, req.user.user_id, note]);
  if (!r.rowCount) bad('ปฏิเสธไม่ได้ (รายการถูกพิจารณาแล้ว หรือเป็นคำขอของตนเอง)');
  await audit(req, { event: 'loan.reject', resource: 'loan', resourceId: req.params.id, detail: note });
  req.flash('ok', 'ปฏิเสธคำขอแล้ว');
  res.redirect('/app/loans/' + req.params.id);
});

router.post('/loans/:id/return', requirePerm('loans.return'), async (req, res) => {
  await tx(async c => {
    const l = (await c.query('SELECT * FROM loans WHERE loan_id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!l) bad('ไม่พบรายการ', 404);
    if (l.status !== 'approved') bad('บันทึกการคืนได้เฉพาะรายการที่กำลังยืม');
    await c.query(`UPDATE loans SET status='returned', returned_at=NOW(), returned_to=$2 WHERE loan_id=$1`,
      [l.loan_id, req.user.user_id]);
    await c.query('UPDATE books SET available_copies=available_copies+1 WHERE book_id=$1', [l.book_id]);
  });
  await audit(req, { event: 'loan.return', resource: 'loan', resourceId: req.params.id });
  req.flash('ok', 'บันทึกการรับคืนแล้ว');
  res.redirect('/app/loans/' + req.params.id);
});

module.exports = router;
