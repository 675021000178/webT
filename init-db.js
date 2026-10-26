// สร้างตารางและข้อมูลตัวอย่างใน PostgreSQL: npm run db:init
const fs = require('node:fs');
const path = require('node:path');
const pool = require('./db');

async function main() {
  for (const file of ['schema.sql', 'seed.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    await pool.query(sql);          // simple query รองรับหลายคำสั่งในไฟล์เดียว
    console.log('OK  ' + file);
  }
  console.log('\nพร้อมใช้งาน: npm start แล้วเปิด http://localhost:' + (process.env.PORT || 3000));
  console.log('บัญชีทดสอบ: admin / librarian / staff / user  รหัสผ่าน 1234!');
}
main().catch(e => { console.error('ผิดพลาด:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
