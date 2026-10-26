// รายการ Permission ที่ "มีโค้ดตรวจสิทธิ์รองรับจริง" ในระบบ
// การเพิ่มชื่อ Permission ในฐานข้อมูลเพียงอย่างเดียวไม่ได้ป้องกันอะไร
// ต้องมี requirePerm('ชื่อ') ใน Route นั้นด้วย (ดูคอลัมน์ guard)
module.exports = [
  { name: 'books.read',        guard: 'GET /app/books, /app/books/:id, /api/app/books', desc: 'ดูรายการและรายละเอียดหนังสือ' },
  { name: 'books.create',      guard: 'GET|POST /app/books/new', desc: 'เพิ่มหนังสือ' },
  { name: 'books.update',      guard: 'GET|POST /app/books/:id/edit', desc: 'แก้ไขหนังสือ' },
  { name: 'books.delete',      guard: 'POST /app/books/:id/delete', desc: 'ลบหนังสือ' },
  { name: 'books.export',      guard: 'GET /app/books/export.csv', desc: 'ส่งออกรายการหนังสือเป็น CSV' },
  { name: 'loans.create',      guard: 'POST /app/books/:id/request', desc: 'ส่งคำขอยืมหนังสือ' },
  { name: 'loans.read.own',    guard: 'GET /app/loans, /app/loans/:id (เฉพาะของตน)', desc: 'ดูรายการยืมของตนเอง' },
  { name: 'loans.read.all',    guard: 'GET /app/loans, /app/loans/:id (ทุกคน)', desc: 'ดูรายการยืมของทุกคน' },
  { name: 'loans.cancel.own',  guard: 'POST /app/loans/:id/cancel (เจ้าของ + pending)', desc: 'ยกเลิกคำขอของตนเอง (เฉพาะที่ยังรออนุมัติ)' },
  { name: 'loans.approve',     guard: 'POST /app/loans/:id/approve|reject', desc: 'อนุมัติหรือปฏิเสธคำขอยืม' },
  { name: 'loans.return',      guard: 'POST /app/loans/:id/return', desc: 'บันทึกการรับคืนหนังสือ' },
  { name: 'files.upload',      guard: 'POST /files/book/:id', desc: 'อัปโหลดภาพ/ไฟล์ของหนังสือ' },
  { name: 'files.read',        guard: 'GET /files/:id', desc: 'เปิดดูหรือดาวน์โหลดไฟล์' },
  { name: 'files.delete',      guard: 'POST /files/:id/delete', desc: 'ลบไฟล์' },
  { name: 'logs.read',         guard: 'GET /admin/logs, /api/admin/logs', desc: 'ดู Log การใช้งานย้อนหลัง' },
  { name: 'admin.users',       guard: '/admin/users/*, /api/admin/users', desc: 'จัดการผู้ใช้ (ส่วน Admin)' },
  { name: 'admin.roles',       guard: '/admin/roles/*, /api/admin/roles', desc: 'จัดการ Role (ส่วน Admin)' },
  { name: 'admin.permissions', guard: '/admin/permissions/*', desc: 'จัดการรายการ Permission (ส่วน Admin)' },
  { name: 'admin.acl',         guard: '/admin/acl', desc: 'กำหนดสิทธิ์ Role x Permission (ส่วน Admin)' }
];
