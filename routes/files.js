// อัปโหลด / เปิดดู / ลบไฟล์ — ไฟล์เก็บใน uploads/ (ไม่เปิดเป็น public) และตรวจสิทธิ์ทุกครั้งที่เข้าถึง
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const router = require('express').Router();
const pool = require('../db');
const audit = require('../lib/audit');
const { requireLogin, requirePerm, bad, idParam } = require('../middleware');

const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads');
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 3 * 1024 * 1024);
const upload = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } });

router.use(requireLogin);
router.param('id', idParam);

// ตรวจชนิดไฟล์จาก "เนื้อหาจริง" (magic bytes) ไม่เชื่อนามสกุลหรือ Content-Type ที่ผู้ใช้ส่งมา
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: '.png' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  return null;
}
function cleanName(name) {
  let n = Buffer.from(String(name || ''), 'latin1').toString('utf8');   // multer ส่งชื่อไทยเป็น latin1
  if (n.includes('\uFFFD')) n = String(name || '');
  n = path.basename(n.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return (n || 'file').slice(0, 200);
}

// ---------- อัปโหลด (POST /files/book/:id?_csrf=...) ----------
router.post('/book/:id', requirePerm('files.upload'), (req, res, next) => {
  upload.single('file')(req, res, async err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'ไฟล์ใหญ่เกินกำหนด (สูงสุด ' + (MAX_BYTES / 1024 / 1024).toFixed(0) + ' MB)'
      : 'อัปโหลดไม่สำเร็จ: ' + err.message;
    await audit(req, { event: 'file.upload', resource: 'book', resourceId: req.params.id, result: 'failure', detail: msg });
    req.flash('err', msg);
    res.redirect('/app/books/' + req.params.id);
  });
}, async (req, res) => {
  const back = '/app/books/' + req.params.id;
  const book = (await pool.query('SELECT book_id FROM books WHERE book_id=$1', [req.params.id])).rows[0];
  if (!book) bad('ไม่พบหนังสือ', 404);
  const fail = async msg => {
    await audit(req, { event: 'file.upload', resource: 'book', resourceId: book.book_id, result: 'failure', detail: msg });
    req.flash('err', msg); res.redirect(back);
  };
  if (!req.file || !req.file.size) return fail('กรุณาเลือกไฟล์ก่อนอัปโหลด');
  const kind = sniff(req.file.buffer);
  if (!kind) return fail('ชนิดไฟล์ไม่รองรับ (อนุญาตเฉพาะ JPG, PNG, WEBP และ PDF)');
  const stored = crypto.randomUUID() + kind.ext;               // ชื่อที่เก็บสุ่มใหม่ ไม่ชนกัน ไม่ใช้ชื่อจากผู้ใช้
  const original = cleanName(req.file.originalname);
  await fs.writeFile(path.join(UPLOAD_DIR, stored), req.file.buffer, { flag: 'wx' });
  try {
    const r = await pool.query(
      `INSERT INTO book_files (book_id, original_name, stored_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING file_id`,
      [book.book_id, original, stored, kind.mime, req.file.size, req.user.user_id]);
    await audit(req, { event: 'file.upload', resource: 'file', resourceId: r.rows[0].file_id,
      detail: original + ' (' + kind.mime + ', ' + req.file.size + ' bytes) -> book ' + book.book_id });
  } catch (e) {
    await fs.unlink(path.join(UPLOAD_DIR, stored)).catch(() => {});
    throw e;
  }
  req.flash('ok', 'อัปโหลดไฟล์เรียบร้อย');
  res.redirect(back);
});

// ---------- เปิดดู / ดาวน์โหลด (ตรวจ files.read ทุกครั้ง) ----------
router.get('/:id', requirePerm('files.read'), async (req, res, next) => {
  const f = (await pool.query('SELECT * FROM book_files WHERE file_id=$1', [req.params.id])).rows[0];
  if (!f) bad('ไม่พบไฟล์', 404);
  const download = req.query.download === '1';
  if (download) res.attachment(f.original_name); else res.set('Content-Disposition', 'inline');
  res.set({ 'Content-Type': f.mime_type, 'Cache-Control': 'private, max-age=0',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
  res.sendFile(path.join(UPLOAD_DIR, f.stored_name), { dotfiles: 'deny' }, err => err && next(err));
});

router.post('/:id/delete', requirePerm('files.delete'), async (req, res) => {
  const r = await pool.query('DELETE FROM book_files WHERE file_id=$1 RETURNING *', [req.params.id]);
  if (!r.rowCount) bad('ไม่พบไฟล์', 404);
  await fs.unlink(path.join(UPLOAD_DIR, r.rows[0].stored_name)).catch(() => {});
  await audit(req, { event: 'file.delete', resource: 'file', resourceId: req.params.id, detail: r.rows[0].original_name });
  req.flash('ok', 'ลบไฟล์แล้ว');
  res.redirect('/app/books/' + r.rows[0].book_id);
});

module.exports = router;
