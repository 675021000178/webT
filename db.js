const { Pool } = require('pg');
// อ่านค่าจาก PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD ใน .env
module.exports = new Pool();
