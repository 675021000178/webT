// โหลดค่าจากไฟล์ .env ถ้ามี (รันในเครื่อง) ถ้าไม่มี (เช่นบน Render) ใช้ Environment Variables ของโฮสต์
try { process.loadEnvFile(); } catch { /* ไม่มี .env */ }
const { Pool } = require('pg');
// รันในเครื่อง: อ่าน PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD จาก .env
// รันออนไลน์: ตั้ง DATABASE_URL ตัวเดียว (เช่นจาก Neon / Render) จะเปิด SSL ให้อัตโนมัติ
// ถ้าฐานข้อมูลไม่รองรับ SSL ให้ตั้ง PGSSL=disable
const url = process.env.DATABASE_URL;
if (url) {
  console.log('✅ เชื่อมต่อไปยัง PostgreSQL ผ่าน DATABASE_URL');
} else {
  console.error('❌ ไม่พบค่า DATABASE_URL ใน Environment Variables! (กำลังพยายามเชื่อมต่อไปยัง localhost:5432)');
}

const pool = url
  ? new Pool({ connectionString: url, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } })
  : new Pool();

pool.on('error', (err) => {
  console.error('❌ Database Pool Error:', err.message);
});

module.exports = pool;
