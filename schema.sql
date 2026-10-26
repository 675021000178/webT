-- =====================================================================
-- schema.sql : โครงสร้างฐานข้อมูลระบบยืมคืนหนังสือห้องสมุด
-- คำเตือน: ไฟล์นี้ DROP ตารางเดิมก่อนสร้างใหม่ ใช้กับฐานข้อมูล library_db เท่านั้น
-- =====================================================================
DROP TABLE IF EXISTS audit_logs, book_files, loans, books, role_permissions,
  users, permissions, roles, session CASCADE;

-- ---------- Authorization: Role / Permission / ACL ----------
CREATE TABLE roles (
  role_id      SERIAL PRIMARY KEY,
  role_name    VARCHAR(50) UNIQUE NOT NULL CHECK (role_name ~ '^[a-z0-9_]{2,50}$'),
  description  VARCHAR(255) NOT NULL DEFAULT '',
  is_superuser BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE = ทำได้ทุกฟังก์ชัน (Admin)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
  permission_id   SERIAL PRIMARY KEY,
  permission_name VARCHAR(100) UNIQUE NOT NULL,   -- เช่น books.read
  description     VARCHAR(255) NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ACL : Role x Permission (1 แถว = 1 Role ได้ 1 Permission)
CREATE TABLE role_permissions (
  role_id       INT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  permission_id INT NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

-- ---------- Authentication ----------
CREATE TABLE users (
  user_id       SERIAL PRIMARY KEY,
  username      VARCHAR(50) UNIQUE NOT NULL,
  full_name     VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,            -- bcrypt (มี salt ในตัว)
  role_id       INT NOT NULL REFERENCES roles(role_id),  -- RESTRICT: ลบ Role ที่ยังมีผู้ใช้ไม่ได้
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- ระบบงาน: หนังสือ / คำขอยืม / ไฟล์ ----------
CREATE TABLE books (
  book_id          SERIAL PRIMARY KEY,
  isbn             VARCHAR(20),
  title            VARCHAR(255) NOT NULL,
  author           VARCHAR(255) NOT NULL,
  category         VARCHAR(100) NOT NULL DEFAULT 'ทั่วไป',
  description      TEXT NOT NULL DEFAULT '',
  total_copies     INT NOT NULL CHECK (total_copies >= 0),
  available_copies INT NOT NULL CHECK (available_copies >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (available_copies <= total_copies)
);

-- สถานะ: pending(รออนุมัติ) approved(กำลังยืม) rejected(ปฏิเสธ) returned(คืนแล้ว) cancelled(ยกเลิก)
CREATE TABLE loans (
  loan_id       SERIAL PRIMARY KEY,
  book_id       INT NOT NULL REFERENCES books(book_id),
  user_id       INT NOT NULL REFERENCES users(user_id),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  note          VARCHAR(500) NOT NULL DEFAULT '',
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by    INT REFERENCES users(user_id),
  decided_at    TIMESTAMPTZ,
  decision_note VARCHAR(500) NOT NULL DEFAULT '',
  due_date      DATE,
  returned_at   TIMESTAMPTZ,
  returned_to   INT REFERENCES users(user_id)
);
CREATE INDEX idx_loans_user ON loans(user_id);
CREATE INDEX idx_loans_status ON loans(status);

-- ไฟล์/ภาพที่อัปโหลด (ตัวไฟล์เก็บในโฟลเดอร์ uploads/ ซึ่งไม่เปิดเป็น public)
CREATE TABLE book_files (
  file_id       SERIAL PRIMARY KEY,
  book_id       INT NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(100) UNIQUE NOT NULL,
  mime_type     VARCHAR(100) NOT NULL,
  size_bytes    INT NOT NULL,
  uploaded_by   INT REFERENCES users(user_id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_book_files_book ON book_files(book_id);

-- ---------- Log (ไม่ผูก FK กับ users เพื่อให้ Log คงอยู่แม้ลบผู้ใช้) ----------
CREATE TABLE audit_logs (
  log_id      BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id     INT,
  username    VARCHAR(80),          -- ชื่อบัญชีที่กระทำ/ที่พยายามเข้าสู่ระบบ
  event       VARCHAR(60) NOT NULL, -- เช่น login, role.create, acl.grant
  resource    VARCHAR(60),
  resource_id VARCHAR(60),
  result      VARCHAR(10) NOT NULL CHECK (result IN ('success','failure','denied')),
  ip_address  VARCHAR(64),
  detail      VARCHAR(500)
);
CREATE INDEX idx_logs_created ON audit_logs(created_at DESC);
CREATE INDEX idx_logs_user ON audit_logs(username);
CREATE INDEX idx_logs_event ON audit_logs(event);

-- ---------- Session Store (connect-pg-simple) ----------
CREATE TABLE session (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_session_expire ON session(expire);
