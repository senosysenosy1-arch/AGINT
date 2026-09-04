/**
 * طبقة قاعدة البيانات — MySQL
 * ------------------------------------------------
 * مسؤولة عن:
 * 1. إنشاء الجداول لو مش موجودة (schema بسيط: جدول واحد للرسائل).
 * 2. حفظ كل رسالة (من المستخدم أو من كلود) مرتبطة برقم الشخص (jid).
 * 3. جلب آخر N رسالة من محادثة معينة عشان نبعتها كـ"سياق" لـ Claude API.
 *
 * ليه جدول واحد بس مش جدولين (contacts + messages)؟
 * عشان المرحلة 1 محتاجة أبسط حاجة تشتغل صح. لما نوصل للمرحلة اللي محتاجين
 * فيها نخزن بيانات إضافية عن كل جهة اتصال (اسم، تفضيلات، إلخ) هنضيف جدول
 * contacts منفصل ونربطه بـ foreign key.
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

/**
 * بينشئ pool اتصالات بقاعدة البيانات، وينشئ الجداول المطلوبة لو أول مرة.
 * لازم تستدعي الدالة دي مرة واحدة وقت بدء تشغيل السيرفر قبل أي استخدام تاني.
 */
async function initDb() {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
  });

  // اختبار الاتصال بدري عشان نطلع بخطأ واضح لو بيانات .env غلط
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      jid VARCHAR(64) NOT NULL,
      role ENUM('user', 'assistant') NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_jid_created (jid, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // جدول التذكيرات — remind_at بتاريخ ووقت "بتوقيت القاهرة المحلي" كنص عادي
  // (DATETIME مش TIMESTAMP) عشان نتجنب تعقيد تحويل التوقيت بين السيرفر
  // وقاعدة البيانات؛ المقارنة بتتم في كود Node.js بنفس منطق التوقيت دايمًا.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      jid VARCHAR(64) NOT NULL,
      message TEXT NOT NULL,
      remind_at DATETIME NOT NULL,
      sent TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_due (sent, remind_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  return pool;
}

/** بيحفظ رسالة واحدة (من المستخدم أو رد كلود) في قاعدة البيانات */
async function saveMessage(jid, role, content) {
  await pool.query(
    'INSERT INTO messages (jid, role, content) VALUES (?, ?, ?)',
    [jid, role, content]
  );
}

/**
 * بيرجع آخر `limit` رسالة من محادثة شخص معين، مرتبة من الأقدم للأحدث
 * (الترتيب ده مهم عشان نبعتها لـ Claude API بنفس ترتيب حصولها فعليًا)
 */
async function getRecentMessages(jid, limit = 20) {
  const [rows] = await pool.query(
    `SELECT role, content FROM messages
     WHERE jid = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [jid, limit]
  );
  return rows.reverse();
}

/** بينشئ تذكير جديد. remindAt لازم يكون نص بصيغة 'YYYY-MM-DD HH:mm:ss' بتوقيت القاهرة */
async function createReminder(jid, message, remindAt) {
  const [result] = await pool.query(
    'INSERT INTO reminders (jid, message, remind_at) VALUES (?, ?, ?)',
    [jid, message, remindAt]
  );
  return result.insertId;
}

/** بيرجع كل التذكيرات اللي وقتها جه ولسه ما اتبعتتش، مقارنة بالوقت الحالي (نص بنفس الصيغة) */
async function getDueReminders(nowStr) {
  const [rows] = await pool.query(
    `SELECT id, jid, message FROM reminders
     WHERE sent = 0 AND remind_at <= ?
     ORDER BY remind_at ASC`,
    [nowStr]
  );
  return rows;
}

/** بيعلّم التذكير إنه اتبعت عشان ملبعتوش تاني */
async function markReminderSent(id) {
  await pool.query('UPDATE reminders SET sent = 1 WHERE id = ?', [id]);
}

module.exports = {
  initDb,
  saveMessage,
  getRecentMessages,
  createReminder,
  getDueReminders,
  markReminderSent,
};
