const pool = require('../db');

// บันทึก Log ลง PostgreSQL  (ห้ามส่งรหัสผ่าน, Session ID หรือ Token เข้ามาใน detail)
async function audit(req, { event, resource = null, resourceId = null,
  result = 'success', detail = null, username = null, userId = null }) {
  try {
    const u = req && req.user;
    await pool.query(
      `INSERT INTO audit_logs
        (user_id, username, event, resource, resource_id, result, ip_address, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId ?? (u ? u.user_id : null), username ?? (u ? u.username : null),
       event, resource, resourceId == null ? null : String(resourceId),
       result, req ? req.ip : null, detail ? String(detail).slice(0, 500) : null]);
  } catch (e) {
    console.error('audit log failed:', e.message);
  }
}
module.exports = audit;
