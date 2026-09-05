/**
 * المرحلة 1 — المحادثة النصية الذكية (MVP)
 * ------------------------------------------------
 * السكريبت ده بيعمل:
 * 1. اتصال بواتساب من خلال Baileys (زي المرحلة 0).
 * 2. حفظ كل رسالة واردة وكل رد في قاعدة بيانات MySQL، مرتبطة برقم المرسل.
 * 3. عند وصول رسالة، بنجيب آخر رسايل المحادثة كـ"سياق" ونبعتها مع الرسالة
 *    الجديدة لـ Claude API، ونرد على الشخص برد كلود.
 */

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');

const { initDb, saveMessage, getRecentMessages } = require('./db');
const { getReply } = require('./claude');
const { startReminderScheduler } = require('./reminders');

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const CONTEXT_MESSAGES_LIMIT = 20; // عدد الرسايل السابقة اللي بتتبعت كسياق لكلود

const logger = pino({ level: 'info' });

// بنمسك أحدث نسخة من sock هنا عشان الـscheduler يقدر يوصلها حتى بعد
// إعادة اتصال (reconnect) بتستبدل الـsock القديم بواحد جديد.
let activeSock = null;

// حماية من حلقة إعادة اتصال سريعة (rapid reconnect loop) — لو حصلت محاولات
// فاشلة كتير في وقت قصير، بنوقف تمامًا بدل ما نستمر، عشان منخليش واتساب
// يحس إن ده نمط هجوم آلي ويحظر الرقم أو الـIP. ده أهم جزء أمان في الملف ده.
const MAX_RAPID_RECONNECTS = 5;
const RECONNECT_WINDOW_MS = 60 * 1000; // نافذة دقيقة واحدة
let reconnectAttempts = 0;
let reconnectWindowStart = Date.now();

function scheduleReconnect() {
  const now = Date.now();
  if (now - reconnectWindowStart > RECONNECT_WINDOW_MS) {
    // نافذة جديدة — نصفّر العداد
    reconnectWindowStart = now;
    reconnectAttempts = 0;
  }
  reconnectAttempts += 1;

  if (reconnectAttempts > MAX_RAPID_RECONNECTS) {
    logger.error(
      `🛑 ${MAX_RAPID_RECONNECTS} محاولات فاشلة خلال دقيقة — هنوقف السيرفر تمامًا عشان منتسببش في حظر من واتساب. ` +
      'شغّل السيرفر يدويًا تاني بعد ما تستنى شوية (10-15 دقيقة على الأقل).'
    );
    process.exit(1);
  }

  // تأخير تصاعدي: 5 ثواني × رقم المحاولة، بحد أقصى 30 ثانية — بيدي فرصة
  // حقيقية للـQR يظهر ويتمسح، بدل محاولات متلاحقة كل أجزاء من الثانية.
  const delayMs = Math.min(5000 * reconnectAttempts, 30000);
  logger.warn(`⏳ هنعيد المحاولة بعد ${delayMs / 1000} ثانية (محاولة ${reconnectAttempts}/${MAX_RAPID_RECONNECTS})...`);
  setTimeout(() => startSock(), delayMs);
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Baileys version: ${version.join('.')} (latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    logger,
    // الإصدارات الحديثة من Baileys شالت خاصية printQRInTerminal التلقائية،
    // فبنطفيها هنا ونرسم الـQR يدويًا بمكتبة qrcode-terminal تحت في
    // connection.update لما نستقبل قيمة qr فعليًا.
    printQRInTerminal: false,
    auth: state,
    // واتساب بقى بيرفض أي عميل بيعلن نفسه كـPlatform.WEB من فبراير 2026،
    // فبنستخدم هوية "Mac OS Desktop" الجاهزة من Baileys بدل متصفح مخصص
    // (اللي كان بيتصنّف كـWEB وبيتسبب في رفض الاتصال).
    browser: Browsers.macOS('Desktop'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ده بديل printQRInTerminal القديمة — لما Baileys يبعت qr جديد،
    // بنرسمه بنفسنا كـASCII في الـLogs عشان تقدر تمسحه من موبايلك.
    if (qr) {
      logger.info('📱 امسح الـQR code ده من واتساب (الأجهزة المرتبطة ← ربط جهاز):');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(
        `الاتصال اتقفل (${statusCode}). ${shouldReconnect ? 'هنحاول نعيد الاتصال...' : 'المستخدم عمل تسجيل خروج — محتاج مسح QR تاني.'}`
      );

      if (shouldReconnect) {
        scheduleReconnect();
      }
    } else if (connection === 'open') {
      activeSock = sock;
      reconnectAttempts = 0; // اتصال ناجح — نصفّر العداد عشان مشاكل مستقبلية متتأثرش بمحاولات قديمة
      logger.info('✅ الاتصال بواتساب اتفتح بنجاح.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const from = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text) continue; // لسه بنركز على رسايل نصية بس في المرحلة دي

      logger.info(`📩 رسالة من ${from}: ${text}`);

      try {
        // بنسجّل حضور الكتابة ("... يكتب") عشان تجربة استخدام أطبع
        await sock.sendPresenceUpdate('composing', from);

        // 1) نجيب سياق المحادثة السابق من قاعدة البيانات
        const history = await getRecentMessages(from, CONTEXT_MESSAGES_LIMIT);

        // 2) نبعت السياق + الرسالة الجديدة لـ Claude ونستنى الرد
        //    (بنبعت jid كمان عشان لو كلود استخدم أداة create_reminder، تتحفظ
        //    مربوطة بالشخص الصح)
        const replyText = await getReply(history, text, from);

        // 3) نحفظ الرسالة الجديدة ورد كلود مع بعض في قاعدة البيانات
        await saveMessage(from, 'user', text);
        await saveMessage(from, 'assistant', replyText);

        // 4) نبعت الرد فعليًا على واتساب
        await sock.sendMessage(from, { text: replyText });
      } catch (err) {
        logger.error(err, `حصل خطأ أثناء الرد على ${from}`);
        await sock.sendMessage(from, {
          text: 'معلش، حصل خطأ تقني وأنا بحاول أرد عليك. جرب تبعت تاني بعد شوية 🙏',
        });
      }
    }
  });

  // Pairing Code — بديل عن مسح QR، خصوصًا مناسب لبيئة زي Railway اللي
  // واجهة اللوجز فيها ممكن تقطّع رسم الـQR. لو حطيت WHATSAPP_PHONE_NUMBER
  // في .env، هنطلب كود من 8 أرقام تكتبه يدويًا في واتساب بدل ما تمسح صورة.
  //
  // ملحوظة مهمة: لازم نستنى شوية بعد إنشاء الـsocket قبل ما نطلب الكود،
  // لأن اتصال الـWebSocket بواتساب بياخد وقت يخلص فعليًا، ولو طلبنا الكود
  // بدري أوي بنستقبل خطأ "Connection Closed (428)" والاتصال كله بيفشل.
  if (!state.creds.registered) {
    const phoneNumber = (process.env.WHATSAPP_PHONE_NUMBER || '').replace(/[^0-9]/g, '');

    if (phoneNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          const formatted = code.match(/.{1,4}/g)?.join('-') || code;
          logger.info('=========================================');
          logger.info(`🔑 كود الربط بتاعك هو: ${formatted}`);
          logger.info('من واتساب: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← اختر "ربط برقم الهاتف بدلاً من ذلك" واكتب الكود ده.');
          logger.info('=========================================');
        } catch (err) {
          logger.error(err, 'فشل طلب كود الربط — تأكد إن رقم WHATSAPP_PHONE_NUMBER صح وبالصيغة الدولية من غير + أو مسافات');
        }
      }, 3000);
    } else {
      logger.warn('WHATSAPP_PHONE_NUMBER مش موجود في .env — هنعتمد على مسح QR code بدلاً من كود الربط.');
    }
  }

  return sock;
}

async function main() {
  logger.info('⏳ بنجهز الاتصال بقاعدة البيانات...');
  await initDb();
  logger.info('✅ قاعدة البيانات جاهزة.');

  // بنمرر دالة (مش قيمة ثابتة) عشان الـscheduler ياخد دايمًا أحدث sock
  // حتى لو حصل reconnect بعد كده
  startReminderScheduler(() => activeSock, logger);

  await startSock();
}

main().catch((err) => {
  logger.error(err, 'حصل خطأ غير متوقع أثناء تشغيل السيرفر');
  process.exit(1);
});
