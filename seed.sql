-- =====================================================================
-- seed.sql : ข้อมูลตัวอย่าง (รันหลัง schema.sql)
-- บัญชีทดสอบ: admin / librarian / staff / user  รหัสผ่านทุกบัญชี = 1234!
-- (เก็บเป็น bcrypt hash ไม่ใช่ข้อความปกติ)
-- =====================================================================
INSERT INTO roles (role_name, description, is_superuser) VALUES
  ('admin',     'ผู้ดูแลระบบ: ใช้งานได้ทุกฟังก์ชัน จัดการผู้ใช้ บทบาท และสิทธิ์', TRUE),
  ('librarian', 'บรรณารักษ์ (ผู้จัดการ): จัดการหนังสือ อนุมัติคำขอ ดู Log', FALSE),
  ('staff',     'เจ้าหน้าที่: พิจารณาคำขอ รับคืนหนังสือ อัปโหลดไฟล์', FALSE),
  ('user',      'สมาชิกทั่วไป: ค้นหาหนังสือ ส่งคำขอยืม ดูของตนเอง', FALSE);

INSERT INTO users (username, full_name, password_hash, role_id) VALUES
  ('admin',     'ผู้ดูแลระบบ',      '$2b$10$NiwQ2F1Ay.JsLDzZ5t4bKuX4cpTPTlVLxJHVFo7GCVO5Ghej9uR32', (SELECT role_id FROM roles WHERE role_name='admin')),
  ('librarian', 'librarian', '$2b$10$66reKqdfFmTJ7KnRCcIVIu7gEWT9A17DZj3FwSE1iuYfZC6ujI5UK',   (SELECT role_id FROM roles WHERE role_name='librarian')),
  ('staff',     'staff', '$2b$10$KMrHVqAuEeGA11mU5I5YCe74DJtzsOiui4bSJCcy40gGZx.npoNnC', (SELECT role_id FROM roles WHERE role_name='staff')),
  ('user',      'user',    '$2b$10$LLkBwznSCx.0gWtG9YcFguwRSdXiZZC.5VxtptIEucQ5re5zbcy8a',  (SELECT role_id FROM roles WHERE role_name='user'));

-- Permission (หมายเหตุ: books.export ตั้งใจไม่ใส่ เพื่อสาธิตการเพิ่ม Permission ผ่านหน้าเว็บ)
INSERT INTO permissions (permission_name, description) VALUES
  ('books.read',         'ดูรายการและรายละเอียดหนังสือ'),
  ('books.create',       'เพิ่มหนังสือ'),
  ('books.update',       'แก้ไขหนังสือ'),
  ('books.delete',       'ลบหนังสือ'),
  ('loans.create',       'ส่งคำขอยืมหนังสือ'),
  ('loans.read.own',     'ดูรายการยืมของตนเอง'),
  ('loans.read.all',     'ดูรายการยืมของทุกคน'),
  ('loans.cancel.own',   'ยกเลิกคำขอของตนเอง (เฉพาะที่ยังรออนุมัติ)'),
  ('loans.approve',      'อนุมัติหรือปฏิเสธคำขอยืม'),
  ('loans.return',       'บันทึกการรับคืนหนังสือ'),
  ('files.upload',       'อัปโหลดภาพ/ไฟล์ของหนังสือ'),
  ('files.read',         'เปิดดูหรือดาวน์โหลดไฟล์'),
  ('files.delete',       'ลบไฟล์'),
  ('logs.read',          'ดู Log การใช้งานย้อนหลัง'),
  ('admin.users',        'จัดการผู้ใช้ (ส่วน Admin)'),
  ('admin.roles',        'จัดการ Role (ส่วน Admin)'),
  ('admin.permissions',  'จัดการรายการ Permission (ส่วน Admin)'),
  ('admin.acl',          'กำหนดสิทธิ์ Role x Permission (ส่วน Admin)');

-- ACL เริ่มต้น (admin เป็น superuser จึงไม่ต้องใส่ทีละรายการ)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r JOIN permissions p ON p.permission_name IN (
  'books.read','books.create','books.update','books.delete',
  'loans.read.all','loans.approve','loans.return',
  'files.upload','files.read','files.delete','logs.read')
WHERE r.role_name='librarian';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r JOIN permissions p ON p.permission_name IN (
  'books.read','loans.read.all','loans.approve','loans.return','files.upload','files.read')
WHERE r.role_name='staff';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r JOIN permissions p ON p.permission_name IN (
  'books.read','loans.create','loans.read.own','loans.cancel.own','files.read')
WHERE r.role_name='user';

-- หนังสือตัวอย่าง (total, available)
INSERT INTO books (isbn, title, author, category, description, total_copies, available_copies) VALUES
  ('9780132350884','Clean Code','Robert C. Martin','คอมพิวเตอร์','แนวทางเขียนโค้ดให้อ่านง่ายและดูแลรักษาได้',3,2),
  ('9780201633610','Design Patterns','Erich Gamma et al.','คอมพิวเตอร์','รูปแบบการออกแบบซอฟต์แวร์เชิงวัตถุ',2,2),
  ('9781491950296','Building Microservices','Sam Newman','คอมพิวเตอร์','การออกแบบระบบแบบไมโครเซอร์วิส',2,2),
  ('9780262033848','Introduction to Algorithms','Cormen et al.','คอมพิวเตอร์','ตำราอัลกอริทึมระดับมหาวิทยาลัย',4,4),
  ('9786160000001','เจ้าชายน้อย','อ็องตวน เดอ แซ็งแต็กซูเปรี','วรรณกรรม','วรรณกรรมเยาวชนที่อ่านได้ทุกวัย',3,3),
  ('9786160000002','คำพิพากษา','ชาติ กอบจิตติ','วรรณกรรม','นวนิยายไทยรางวัลซีไรต์',2,2),
  ('9780000000003','Sapiens','Yuval Noah Harari','ประวัติศาสตร์','ประวัติศาสตร์ย่อของมนุษยชาติ',3,3),
  ('9780735211292','Atomic Habits','James Clear','พัฒนาตนเอง','สร้างนิสัยเล็กๆ ที่เปลี่ยนชีวิต',4,4),
  ('9780062315007','The Alchemist','Paulo Coelho','วรรณกรรม','เรื่องราวการเดินทางตามหาความฝัน',2,2),
  ('9780141439518','Pride and Prejudice','Jane Austen','วรรณกรรม','นวนิยายคลาสสิกของอังกฤษ',2,2),
  ('9780553380163','A Brief History of Time','Stephen Hawking','วิทยาศาสตร์','จักรวาลวิทยาสำหรับผู้อ่านทั่วไป',2,2),
  ('9780143127741','The Martian','Andy Weir','วิทยาศาสตร์','นิยายวิทยาศาสตร์เอาชีวิตรอดบนดาวอังคาร',2,2);

-- รายการยืมตัวอย่าง: คำขอรออนุมัติ / กำลังยืม / คืนแล้ว
INSERT INTO loans (book_id, user_id, status, note, requested_at)
SELECT b.book_id, u.user_id, 'pending', 'ขอยืมไว้อ่านสอบ', NOW() - INTERVAL '2 hours'
FROM books b, users u WHERE b.title='Design Patterns' AND u.username='user';

INSERT INTO loans (book_id, user_id, status, note, requested_at, decided_by, decided_at, due_date)
SELECT b.book_id, u.user_id, 'approved', '', NOW() - INTERVAL '3 days',
  (SELECT user_id FROM users WHERE username='staff'), NOW() - INTERVAL '3 days', CURRENT_DATE + 4
FROM books b, users u WHERE b.title='Clean Code' AND u.username='user';

INSERT INTO loans (book_id, user_id, status, note, requested_at, decided_by, decided_at, due_date, returned_at, returned_to)
SELECT b.book_id, u.user_id, 'returned', '', NOW() - INTERVAL '20 days',
  (SELECT user_id FROM users WHERE username='librarian'), NOW() - INTERVAL '20 days', CURRENT_DATE - 13,
  NOW() - INTERVAL '15 days', (SELECT user_id FROM users WHERE username='staff')
FROM books b, users u WHERE b.title='Atomic Habits' AND u.username='user';
