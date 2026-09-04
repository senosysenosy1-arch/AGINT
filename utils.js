/**
 * دالة مساعدة صغيرة: بترجع الوقت الحالي بتوقيت القاهرة كنص بصيغة
 * 'YYYY-MM-DD HH:mm:ss' — نفس الصيغة اللي بنخزنها بيها في عمود remind_at،
 * عشان المقارنة بين "دلوقتي" و"ميعاد التذكير" تكون متسقة دايمًا.
 */
function nowInCairo() {
  // 'sv-SE' locale بيرجع صيغة قريبة من ISO (YYYY-MM-DD HH:mm:ss) بشكل افتراضي
  const formatted = new Date().toLocaleString('sv-SE', {
    timeZone: 'Africa/Cairo',
  });
  return formatted;
}

module.exports = { nowInCairo };
