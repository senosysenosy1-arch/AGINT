/**
 * Scheduler التذكيرات
 * ------------------------------------------------
 * كل دقيقة، بيفحص جدول reminders في قاعدة البيانات، ولو لقى تذكير وقته
 * جه ولسه ما اتبعتش، بيبعت رسالة واتساب تلقائية للشخص صاحب التذكير.
 *
 * ملحوظة تصميم: الـscheduler محتاج مرجع لـ`sock` (اتصال واتساب) عشان يقدر
 * يبعت رسايل، لكن `sock` بيتغيّر كل ما يحصل إعادة اتصال (reconnect). عشان
 * كده بنستقبل دالة `getSock()` بترجع أحدث نسخة من sock وقت الحاجة، بدل ما
 * نمسك مرجع ثابت ممكن يبقى قديم (stale) بعد إعادة اتصال.
 */

const cron = require('node-cron');
const { getDueReminders, markReminderSent } = require('./db');
const { nowInCairo } = require('./utils');

function startReminderScheduler(getSock, logger) {
  // "* * * * *" = تشغيل كل دقيقة بالظبط
  cron.schedule('* * * * *', async () => {
    try {
      const due = await getDueReminders(nowInCairo());
      if (due.length === 0) return;

      const sock = getSock();
      if (!sock) {
        logger.warn('فيه تذكيرات مستحقة لكن اتصال واتساب مش جاهز دلوقتي — هنحاول تاني الدقيقة الجاية');
        return;
      }

      for (const reminder of due) {
        try {
          await sock.sendMessage(reminder.jid, {
            text: `🔔 تذكير: ${reminder.message}`,
          });
          await markReminderSent(reminder.id);
          logger.info(`✅ اتبعت تذكير رقم ${reminder.id} لـ ${reminder.jid}`);
        } catch (err) {
          logger.error(err, `فشل إرسال تذكير رقم ${reminder.id}`);
          // مبنعلمش الـreminder إنه "sent" لو فشل الإرسال، عشان يتحاول تاني الدقيقة الجاية
        }
      }
    } catch (err) {
      logger.error(err, 'حصل خطأ أثناء فحص التذكيرات المستحقة');
    }
  });

  logger.info('⏰ scheduler التذكيرات شغال (بيفحص كل دقيقة).');
}

module.exports = { startReminderScheduler };
