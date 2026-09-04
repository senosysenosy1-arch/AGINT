/**
 * طبقة Claude API
 * ------------------------------------------------
 * مسؤولة عن تعريف "شخصية" المساعد (system prompt)، تعريف الأدوات (tools)
 * المتاحة له، واستدعاء الموديل مع تنفيذ أي أداة يطلبها لحد ما يوصل لرد
 * نصي نهائي يترجعله على واتساب.
 *
 * إزاي شغالة التذكيرات هنا؟
 * لما تكتب حاجة زي "فكّرني بعد ساعة أكلم أحمد"، كلود مش بيرد بجملة عادية
 * بس — هو بيقرر (من نفسه) إنه يستدعي أداة اسمها create_reminder بمدخلات
 * منطقية (نص التذكير + الميعاد بصيغة تاريخ/وقت). إحنا بننفذ الأداة دي
 * فعليًا (بنحفظ التذكير في قاعدة البيانات)، وبعدين بنرجّع نتيجة التنفيذ
 * لكلود عشان يكمل ويأكدلك الكلام بجملة طبيعية زي "تمام، هفكّرك الساعة 5".
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createReminder } = require('./db');
const { nowInCairo } = require('./utils');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-6';

// تعريف الأدوات المتاحة لكلود. كل أداة جديدة (إرسال رسالة، بحث، إلخ) هتتضاف هنا
// كمان في مراحل تالية، ونضيف حالتها في executeTool تحت.
const TOOLS = [
  {
    name: 'create_reminder',
    description:
      'يسجّل تذكير جديد هيتبعت للمستخدم على واتساب في ميعاد محدد. استخدمها لما المستخدم يطلب إنه يتفكّر بحاجة معينة في وقت معين أو بعد مدة معينة.',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'نص التذكير اللي هيتبعت للمستخدم (مختصر وواضح)',
        },
        remind_at: {
          type: 'string',
          description:
            "تاريخ ووقت التذكير بصيغة 'YYYY-MM-DD HH:mm:ss' بتوقيت القاهرة المحلي. احسبها بنفسك بناءً على الوقت الحالي المذكور في التعليمات، حتى لو المستخدم قال 'بعد ساعة' أو 'بكرة الصبح' أو أي تعبير نسبي.",
        },
      },
      required: ['message', 'remind_at'],
    },
  },
];

function buildSystemPrompt() {
  return `
انت مساعد ذكي بترد على رسائل واتساب. اتكلم باللهجة المصرية العامية بشكل طبيعي وودود،
ردودك مختصرة ومباشرة (احنا في واتساب مش في إيميل)، ومتجنبش الحشو الزيادة.
لو مش متأكد من حاجة، قول كده بصراحة بدل ما تختلق معلومة.

الوقت والتاريخ الحاليين بتوقيت القاهرة: ${nowInCairo()}

لو المستخدم طلب إنك تفكّره بحاجة (بأي صيغة: "فكّرني"، "ذكّرني"، "نبّهني"، إلخ)،
استخدم أداة create_reminder. احسب remind_at كتاريخ ووقت فعلي بناءً على الوقت
الحالي المذكور فوق، حتى لو الطلب بصيغة نسبية زي "بعد نص ساعة" أو "بكرة الساعة 9".
بعد ما الأداة تنفّذ بنجاح، أكّد للمستخدم بجملة طبيعية قصيرة فيها الميعاد اللي فهمته.
`.trim();
}

/** بينفذ أداة معينة فعليًا ويرجع نتيجة التنفيذ كنص (هيتبعت لكلود كـtool_result) */
async function executeTool(name, input, jid) {
  if (name === 'create_reminder') {
    try {
      const id = await createReminder(jid, input.message, input.remind_at);
      return JSON.stringify({ success: true, reminder_id: id });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }
  }

  return JSON.stringify({ success: false, error: `أداة غير معروفة: ${name}` });
}

/**
 * بيبعت المحادثة (سياق + رسالة جديدة) لـ Claude، وينفذ أي أداة يطلبها
 * (لو حصل)، وبيرجع الرد النصي النهائي بس.
 * @param {{role: 'user'|'assistant', content: string}[]} history
 * @param {string} newMessage
 * @param {string} jid - رقم/معرف المرسل، محتاجينه لتنفيذ الأدوات (زي حفظ تذكير)
 * @returns {Promise<string>}
 */
async function getReply(history, newMessage, jid) {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: newMessage },
  ];

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    tools: TOOLS,
    messages,
  });

  // لو كلود طلب استخدام أداة، ننفذها ونرجّعله النتيجة، ونكرر لحد ما يرد بنص عادي
  // (بحد أقصى منطقي عشان نتجنب أي loop لا نهائي في حالة خطأ غريب)
  let safetyCounter = 0;
  while (response.stop_reason === 'tool_use' && safetyCounter < 5) {
    safetyCounter += 1;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const resultText = await executeTool(block.name, block.input, jid);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultText,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });
  }

  const textParts = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text);

  return textParts.join('\n').trim() || 'معلش، حصل خطأ ومقدرتش أرد. جرب تاني.';
}

module.exports = { getReply };
