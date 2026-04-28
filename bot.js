require('dotenv').config();
const { Bot, session, InlineKeyboard } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const pdfParse = require('pdf-parse');
const cron = require('node-cron');

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const bot = new Bot(TELEGRAM_TOKEN);

// ============================================================
// SUPABASE SQL SCHEMA (Supabase Dashboard > SQL Editor da ishga tushiring)
// ============================================================
/*
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language TEXT DEFAULT 'uz',
  bot_style TEXT DEFAULT 'friendly',
  role_persona TEXT DEFAULT 'assistant',
  is_blocked BOOLEAN DEFAULT FALSE,
  quiet_start TIME,
  quiet_end TIME,
  message_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(telegram_id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  mood TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE photo_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(telegram_id),
  file_id TEXT NOT NULL,
  caption TEXT,
  ai_description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(telegram_id),
  message TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  is_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE mood_analytics (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(telegram_id),
  mood TEXT NOT NULL,
  date DATE DEFAULT CURRENT_DATE
);

CREATE INDEX idx_messages_user ON messages(user_id);
CREATE INDEX idx_photos_user ON photo_messages(user_id);
CREATE INDEX idx_reminders_time ON reminders(remind_at);

-- 200 ta xabar limiti
CREATE OR REPLACE FUNCTION cleanup_old_messages() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM messages WHERE user_id = NEW.user_id AND id NOT IN (
    SELECT id FROM messages WHERE user_id = NEW.user_id ORDER BY created_at DESC LIMIT 200
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_cleanup_messages AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION cleanup_old_messages();

-- 50 ta rasm limiti
CREATE OR REPLACE FUNCTION cleanup_old_photos() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM photo_messages WHERE user_id = NEW.user_id AND id NOT IN (
    SELECT id FROM photo_messages WHERE user_id = NEW.user_id ORDER BY created_at DESC LIMIT 50
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_cleanup_photos AFTER INSERT ON photo_messages FOR EACH ROW EXECUTE FUNCTION cleanup_old_photos();
*/

// ============================================================
// CONSTANTS
// ============================================================
const PERSONAS = {
  assistant: "Sen foydali va do'stona AI yordamchisan.",
  friend: "Sen foydalanuvchining yaqin do'stisan. Samimiy, hazilkash va qo'llab-quvvatlovchi gapir.",
  teacher: "Sen tajribali o'qituvchisan. Har narsani aniq, sabr bilan va misollar bilan tushuntir.",
  psychologist: "Sen empatik psixologsan. Foydalanuvchini diqqat bilan tingla, his-tuyg'ularini tushun.",
  coach: "Sen motivatsion coachsan. Energik, ijobiy va maqsadga yo'naltirilgan gapir."
};

const LANG_PROMPTS = {
  uz: "Faqat O'zbek tilida javob ber.",
  ru: "Отвечай только на русском языке.",
  en: "Reply only in English."
};

const STYLE_PROMPTS = {
  friendly: "Oddiy, do'stona va iliq uslubda gapir.",
  formal: "Rasmiy va professional uslubda gapir.",
  short: "Imkon qadar qisqa va lo'nda javob ber."
};

const LANG_NAMES = { uz: "🇺🇿 O'zbek", ru: "🇷🇺 Русский", en: "🇬🇧 English" };
const STYLE_NAMES = { friendly: "😊 Do'stona", formal: "👔 Rasmiy", short: "⚡ Qisqa" };
const PERSONA_NAMES = {
  assistant: "🤖 Yordamchi", friend: "👫 Do'st",
  teacher: "📚 O'qituvchi", psychologist: "🧠 Psixolog", coach: "🏆 Coach"
};

// ============================================================
// KEYBOARDS
// ============================================================
const mainMenu = () => new InlineKeyboard()
  .text('🔍 Qidirish', 'search').text('⏰ Eslatmalar', 'reminders').row()
  .text('🌐 Tarjima', 'translate').text('📝 Xulosa', 'summarize').row()
  .text('✏️ Grammatika', 'grammar').text('📖 Hikoya', 'story').row()
  .text('🎭 Rol tanlash', 'persona').text('⚙️ Sozlamalar', 'settings').row()
  .text('📊 Statistika', 'stats').text('💾 Eksport', 'export').row()
  .text('🧩 Quiz', 'quiz').text('💡 Kunlik maslahat', 'daily_tip');

const settingsMenu = () => new InlineKeyboard()
  .text('🌍 Til', 'set_language').text('🎨 Uslub', 'set_style').row()
  .text('🌙 Tinch vaqt', 'quiet_time').text('🔙 Orqaga', 'back_main');

const langMenu = () => new InlineKeyboard()
  .text("🇺🇿 O'zbek", 'lang_uz').text('🇷🇺 Русский', 'lang_ru').text('🇬🇧 English', 'lang_en').row()
  .text('🔙 Orqaga', 'back_settings');

const styleMenu = () => new InlineKeyboard()
  .text("😊 Do'stona", 'style_friendly').text('👔 Rasmiy', 'style_formal').text('⚡ Qisqa', 'style_short').row()
  .text('🔙 Orqaga', 'back_settings');

const personaMenu = () => new InlineKeyboard()
  .text('🤖 Yordamchi', 'persona_assistant').text("👫 Do'st", 'persona_friend').row()
  .text("📚 O'qituvchi", 'persona_teacher').text('🧠 Psixolog', 'persona_psychologist').row()
  .text('🏆 Coach', 'persona_coach').text('🔙 Orqaga', 'back_main');

const adminMenu = () => new InlineKeyboard()
  .text('📢 Broadcast', 'admin_broadcast').text('📊 Stats', 'admin_stats').row()
  .text('🚫 Bloklash', 'admin_block').text('✅ Ochish', 'admin_unblock');

// ============================================================
// DATABASE HELPERS
// ============================================================
async function getOrCreateUser(tgUser) {
  const { data } = await supabase.from('users').upsert({
    telegram_id: tgUser.id,
    username: tgUser.username,
    first_name: tgUser.first_name,
    last_name: tgUser.last_name,
    updated_at: new Date().toISOString()
  }, { onConflict: 'telegram_id' }).select().single();
  return data;
}

async function getUser(telegramId) {
  const { data } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
  return data;
}

async function updateUser(telegramId, updates) {
  const { data } = await supabase.from('users')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('telegram_id', telegramId).select().single();
  return data;
}

async function saveMessage(userId, role, content, mood = null) {
  await supabase.from('messages').insert({ user_id: userId, role, content, mood });
}

async function getHistory(userId, limit = 20) {
  const { data } = await supabase.from('messages').select('role, content')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  return (data || []).reverse();
}

async function searchMessages(userId, query) {
  const { data } = await supabase.from('messages').select('role, content, created_at')
    .eq('user_id', userId).ilike('content', `%${query}%`)
    .order('created_at', { ascending: false }).limit(10);
  return data || [];
}

async function savePhoto(userId, fileId, caption, aiDescription) {
  await supabase.from('photo_messages').insert({ user_id: userId, file_id: fileId, caption, ai_description: aiDescription });
}

async function saveMood(userId, mood) {
  await supabase.from('mood_analytics').insert({ user_id: userId, mood, date: new Date().toISOString().split('T')[0] });
}

async function getUserStats(telegramId) {
  const user = await getUser(telegramId);
  const { count: msgCount } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('user_id', telegramId);
  const { count: photoCount } = await supabase.from('photo_messages').select('*', { count: 'exact', head: true }).eq('user_id', telegramId);
  const { data: moods } = await supabase.from('mood_analytics').select('mood').eq('user_id', telegramId)
    .gte('date', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]);
  const moodCount = {};
  moods?.forEach(m => { moodCount[m.mood] = (moodCount[m.mood] || 0) + 1; });
  const topMood = Object.entries(moodCount).sort((a, b) => b[1] - a[1])[0];
  return { user, totalMessages: msgCount || 0, totalPhotos: photoCount || 0, topMood: topMood?.[0] || 'neytral' };
}

async function getAllUsers() {
  const { data } = await supabase.from('users').select('telegram_id, first_name').eq('is_blocked', false);
  return data || [];
}

async function createReminder(userId, message, remindAt) {
  const { data } = await supabase.from('reminders').insert({ user_id: userId, message, remind_at: remindAt }).select().single();
  return data;
}

async function getUserReminders(userId) {
  const { data } = await supabase.from('reminders').select('*').eq('user_id', userId).eq('is_sent', false)
    .gte('remind_at', new Date().toISOString()).order('remind_at', { ascending: true });
  return data || [];
}

async function deleteReminder(id, userId) {
  await supabase.from('reminders').delete().eq('id', id).eq('user_id', userId);
}

async function exportHistory(userId) {
  const { data } = await supabase.from('messages').select('role, content, created_at')
    .eq('user_id', userId).order('created_at', { ascending: true });
  return data || [];
}

// ============================================================
// AI HELPERS
// ============================================================
async function aiChat(userMessage, history = [], user = {}) {
  const persona = PERSONAS[user.role_persona] || PERSONAS.assistant;
  const style = STYLE_PROMPTS[user.bot_style] || STYLE_PROMPTS.friendly;
  const lang = LANG_PROMPTS[user.language] || LANG_PROMPTS.uz;
  const systemPrompt = `${persona} ${style} ${lang} Foydalanuvchi ismi: ${user.first_name || 'Foydalanuvchi'}. Avvalgi xabarlarni eslab qol.`;
  const messages = [...history.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: userMessage }];
  const res = await anthropic.messages.create({ model: 'claude-opus-4-5', max_tokens: 1000, system: systemPrompt, messages });
  return res.content[0].text;
}

async function aiAnalyzeImage(base64, caption = '', user = {}) {
  const lang = LANG_PROMPTS[user.language] || LANG_PROMPTS.uz;
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 800,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
      { type: 'text', text: `Ushbu rasmni tahlil qil. ${caption ? 'Izoh: ' + caption : ''} ${lang}` }
    ]}]
  });
  return res.content[0].text;
}

async function aiTranslate(text, targetLang) {
  const names = { uz: "O'zbek", ru: 'Rus', en: 'Ingliz' };
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 800,
    messages: [{ role: 'user', content: `Quyidagi matnni ${names[targetLang] || targetLang} tiliga tarjima qil. Faqat tarjimani yoz:\n\n${text}` }]
  });
  return res.content[0].text;
}

async function aiSummarize(text) {
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 500,
    messages: [{ role: 'user', content: `Quyidagi matnni 3-5 gapda xulosa qil:\n\n${text}` }]
  });
  return res.content[0].text;
}

async function aiGrammar(text) {
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 600,
    messages: [{ role: 'user', content: `Quyidagi matndagi grammatika xatolarini to'g'irla. Avval to'g'rilangan matn, keyin xatolar izohini yoz:\n\n${text}` }]
  });
  return res.content[0].text;
}

async function aiMood(text) {
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 20,
    messages: [{ role: 'user', content: `Kayfiyatni bitta so'z bilan ayt (xursand/xafa/g'azablangan/xotirjam/hayajonlangan/neytral):\n${text}` }]
  });
  return res.content[0].text.trim().toLowerCase();
}

async function aiStory(prompt, history = []) {
  const storyHistory = history.filter(h => h.content?.startsWith('[HIKOYA]'));
  const messages = [
    ...storyHistory.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: `[HIKOYA] ${prompt}` }
  ];
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 1000,
    system: "Sen ijodiy hikoya yozuvchisan. Foydalanuvchi bilan interaktiv hikoya yarat. Har safar davomini yoz va 2-3 variant taklif qil.",
    messages
  });
  return res.content[0].text;
}

async function aiQuiz(topic) {
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 600,
    messages: [{ role: 'user', content: `"${topic}" mavzusida 1 ta test savoli yarat. Faqat JSON: {"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"correct":"A","explanation":"..."}` }]
  });
  try { return JSON.parse(res.content[0].text.replace(/```json|```/g, '').trim()); }
  catch { return null; }
}

async function aiDailyTip(language = 'uz') {
  const lang = LANG_PROMPTS[language] || LANG_PROMPTS.uz;
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 300,
    messages: [{ role: 'user', content: `Bugun uchun foydali va motivatsion maslahat yoz. ${lang}` }]
  });
  return res.content[0].text;
}

// ============================================================
// SPAM PROTECTION
// ============================================================
const spamMap = new Map();
function checkSpam(userId) {
  const now = Date.now();
  const data = spamMap.get(userId) || { count: 0, resetAt: now + 60000 };
  if (now > data.resetAt) { data.count = 0; data.resetAt = now + 60000; }
  data.count++;
  spamMap.set(userId, data);
  return data.count > 20;
}

// ============================================================
// MIDDLEWARE
// ============================================================
bot.use(session({ initial: () => ({ waitingFor: null, extra: null }) }));

bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  if (checkSpam(ctx.from.id)) return ctx.reply('⚠️ Juda tez xabar yubormoqdasiz. Bir oz kuting.');
  await getOrCreateUser(ctx.from);
  await next();
});

// ============================================================
// COMMANDS
// ============================================================
bot.command('start', async (ctx) => {
  const name = ctx.from.first_name || 'Foydalanuvchi';
  await ctx.reply(
    `👋 Salom, *${name}*!\n\nMen sizning AI yordamchingizman 🤖\n\n` +
    `✅ Erkin suhbat\n✅ Rasm tahlili\n✅ Ovozni matnga\n✅ PDF o'qish\n` +
    `✅ Tarjima | Xulosa | Grammatika\n✅ Hikoya | Quiz | Eslatmalar\n✅ Va ko'p narsa!\n\n` +
    `Boshlash uchun yozing yoki quyidagi menyuni ishlatng:`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
});

bot.command('menu', async (ctx) => {
  await ctx.reply('📋 Asosiy menyu:', { reply_markup: mainMenu() });
});

bot.command('stats', async (ctx) => {
  const stats = await getUserStats(ctx.from.id);
  const u = stats.user;
  const since = u?.created_at ? new Date(u.created_at).toLocaleDateString('uz-UZ') : '-';
  await ctx.reply(
    `📊 *Sizning statistikangiz*\n\n` +
    `👤 Ism: ${u?.first_name || '-'}\n` +
    `🌍 Til: ${LANG_NAMES[u?.language] || '-'}\n` +
    `🎭 Rol: ${PERSONA_NAMES[u?.role_persona] || '-'}\n` +
    `💬 Xabarlar: ${stats.totalMessages}\n` +
    `🖼️ Rasmlar: ${stats.totalPhotos}\n` +
    `😊 Kayfiyat (7 kun): ${stats.topMood}\n` +
    `📅 A'zo bo'lgan: ${since}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('search', async (ctx) => {
  ctx.session.waitingFor = 'search';
  await ctx.reply('🔍 Qidirish uchun so\'z yozing:');
});

bot.command('export', async (ctx) => {
  await ctx.replyWithChatAction('upload_document');
  const history = await exportHistory(ctx.from.id);
  if (history.length === 0) return ctx.reply('📭 Hali xabarlar yo\'q.');
  let text = `📋 Suhbat tarixi (${history.length} ta xabar)\n${'='.repeat(40)}\n\n`;
  history.forEach(m => {
    const date = new Date(m.created_at).toLocaleString('uz-UZ');
    text += `[${date}] ${m.role === 'user' ? '👤 Siz' : '🤖 Bot'}:\n${m.content}\n\n`;
  });
  await ctx.replyWithDocument(new Blob([text], { type: 'text/plain' }), {
    filename: `suhbat_${ctx.from.id}.txt`
  });
});

bot.command('admin', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply('❌ Ruxsat yo\'q.');
  await ctx.reply('👑 *Admin panel*', { parse_mode: 'Markdown', reply_markup: adminMenu() });
});

bot.command('remind', async (ctx) => {
  ctx.session.waitingFor = 'reminder';
  await ctx.reply('⏰ Eslatma yarating:\n\nFormat: `Xabar matni | YYYY-MM-DD HH:MM`\nMisol: `Dori ichish | 2024-12-25 14:30`', { parse_mode: 'Markdown' });
});

bot.command('quiz', async (ctx) => {
  ctx.session.waitingFor = 'quiz_topic';
  await ctx.reply('🧩 Quiz mavzusini yozing (masalan: tarix, matematika, sport):');
});

// ============================================================
// CALLBACK HANDLERS
// ============================================================
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  await ctx.answerCallbackQuery();

  // Navigation
  if (data === 'back_main') return ctx.editMessageText('📋 Asosiy menyu:', { reply_markup: mainMenu() });
  if (data === 'back_settings') return ctx.editMessageText('⚙️ Sozlamalar:', { reply_markup: settingsMenu() });
  if (data === 'settings') return ctx.editMessageText('⚙️ Sozlamalar:', { reply_markup: settingsMenu() });
  if (data === 'persona') return ctx.editMessageText('🎭 Rol tanlang:', { reply_markup: personaMenu() });
  if (data === 'set_language') return ctx.editMessageText('🌍 Tilni tanlang:', { reply_markup: langMenu() });
  if (data === 'set_style') return ctx.editMessageText('🎨 Uslubni tanlang:', { reply_markup: styleMenu() });

  // Language
  if (data.startsWith('lang_')) {
    const lang = data.replace('lang_', '');
    await updateUser(userId, { language: lang });
    return ctx.editMessageText(`✅ Til o'zgartirildi: ${LANG_NAMES[lang]}`, { reply_markup: settingsMenu() });
  }

  // Style
  if (data.startsWith('style_')) {
    const style = data.replace('style_', '');
    await updateUser(userId, { bot_style: style });
    return ctx.editMessageText(`✅ Uslub o'zgartirildi: ${STYLE_NAMES[style]}`, { reply_markup: settingsMenu() });
  }

  // Persona
  if (data.startsWith('persona_')) {
    const persona = data.replace('persona_', '');
    await updateUser(userId, { role_persona: persona });
    return ctx.editMessageText(`✅ Rol o'zgartirildi: ${PERSONA_NAMES[persona]}`, { reply_markup: mainMenu() });
  }

  // Features
  if (data === 'search') {
    ctx.session.waitingFor = 'search';
    return ctx.editMessageText('🔍 Qidirish uchun so\'z yozing:');
  }

  if (data === 'translate') {
    ctx.session.waitingFor = 'translate_lang';
    return ctx.editMessageText('🌐 Qaysi tilga tarjima qilishni tanlang:', {
      reply_markup: new InlineKeyboard()
        .text("🇺🇿 O'zbek", 'tl_uz').text('🇷🇺 Русский', 'tl_ru').text('🇬🇧 English', 'tl_en')
    });
  }

  if (data.startsWith('tl_')) {
    const lang = data.replace('tl_', '');
    ctx.session.extra = lang;
    ctx.session.waitingFor = 'translate_text';
    return ctx.editMessageText('Tarjima qilinadigan matnni yuboring:');
  }

  if (data === 'summarize') {
    ctx.session.waitingFor = 'summarize';
    return ctx.editMessageText('📝 Xulosa qilinadigan matnni yuboring:');
  }

  if (data === 'grammar') {
    ctx.session.waitingFor = 'grammar';
    return ctx.editMessageText('✏️ Grammatikasini tekshiriladigan matnni yuboring:');
  }

  if (data === 'story') {
    ctx.session.waitingFor = 'story';
    return ctx.editMessageText('📖 Hikoya mavzusini yoki boshlanishini yozing:');
  }

  if (data === 'quiz') {
    ctx.session.waitingFor = 'quiz_topic';
    return ctx.editMessageText('🧩 Quiz mavzusini yozing:');
  }

  if (data === 'daily_tip') {
    await ctx.editMessageText('💡 Maslahat tayyorlanmoqda...');
    const user = await getUser(userId);
    const tip = await aiDailyTip(user?.language || 'uz');
    return ctx.editMessageText(`💡 *Kunlik maslahat:*\n\n${tip}`, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('🔙 Menyu', 'back_main') });
  }

  if (data === 'stats') {
    const stats = await getUserStats(userId);
    const u = stats.user;
    const since = u?.created_at ? new Date(u.created_at).toLocaleDateString('uz-UZ') : '-';
    return ctx.editMessageText(
      `📊 *Statistika*\n\n💬 Xabarlar: ${stats.totalMessages}\n🖼️ Rasmlar: ${stats.totalPhotos}\n` +
      `😊 Kayfiyat: ${stats.topMood}\n🎭 Rol: ${PERSONA_NAMES[u?.role_persona] || '-'}\n📅 A'zo: ${since}`,
      { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('🔙 Menyu', 'back_main') }
    );
  }

  if (data === 'export') {
    await ctx.editMessageText('💾 Eksport tayyorlanmoqda...');
    const history = await exportHistory(userId);
    if (history.length === 0) return ctx.reply('📭 Hali xabarlar yo\'q.');
    let text = `📋 Suhbat tarixi (${history.length} ta xabar)\n${'='.repeat(40)}\n\n`;
    history.forEach(m => {
      const date = new Date(m.created_at).toLocaleString('uz-UZ');
      text += `[${date}] ${m.role === 'user' ? '👤 Siz' : '🤖 Bot'}:\n${m.content}\n\n`;
    });
    const buf = Buffer.from(text, 'utf-8');
    await bot.api.sendDocument(userId, new Blob([buf], { type: 'text/plain' }), {}, { filename: `suhbat_${userId}.txt` });
    return;
  }

  if (data === 'reminders') {
    const rems = await getUserReminders(userId);
    if (rems.length === 0) {
      const kb = new InlineKeyboard().text('➕ Yangi eslatma', 'new_reminder').text('🔙 Orqaga', 'back_main');
      return ctx.editMessageText('⏰ Faol eslatmalar yo\'q.', { reply_markup: kb });
    }
    let txt = '⏰ *Faol eslatmalar:*\n\n';
    const kb = new InlineKeyboard();
    rems.forEach((r, i) => {
      const dt = new Date(r.remind_at).toLocaleString('uz-UZ');
      txt += `${i + 1}. ${r.message}\n📅 ${dt}\n\n`;
      kb.text(`❌ ${i + 1}-ni o'chirish`, `del_rem_${r.id}`).row();
    });
    kb.text('➕ Yangi', 'new_reminder').text('🔙 Orqaga', 'back_main');
    return ctx.editMessageText(txt, { parse_mode: 'Markdown', reply_markup: kb });
  }

  if (data === 'new_reminder') {
    ctx.session.waitingFor = 'reminder';
    return ctx.editMessageText('⏰ Eslatma:\n\nFormat: `Xabar | YYYY-MM-DD HH:MM`\nMisol: `Dori ichish | 2024-12-25 14:30`', { parse_mode: 'Markdown' });
  }

  if (data.startsWith('del_rem_')) {
    const id = parseInt(data.replace('del_rem_', ''));
    await deleteReminder(id, userId);
    return ctx.editMessageText('✅ Eslatma o\'chirildi.', { reply_markup: new InlineKeyboard().text('🔙 Menyu', 'back_main') });
  }

  if (data === 'quiet_time') {
    ctx.session.waitingFor = 'quiet_time';
    return ctx.editMessageText('🌙 Tinch vaqtni kiriting:\nFormat: `HH:MM-HH:MM`\nMisol: `23:00-07:00`', { parse_mode: 'Markdown' });
  }

  // Quiz answer
  if (data.startsWith('quiz_ans_')) {
    const parts = data.split('_');
    const chosen = parts[2];
    const correct = ctx.session.extra?.correct;
    const explanation = ctx.session.extra?.explanation;
    if (chosen === correct) {
      return ctx.editMessageText(`✅ *To'g'ri!*\n\n${explanation}`, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('🧩 Yana quiz', 'quiz').text('🔙 Menyu', 'back_main') });
    } else {
      return ctx.editMessageText(`❌ *Noto'g'ri!*\nTo'g'ri javob: *${correct}*\n\n${explanation}`, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('🧩 Yana quiz', 'quiz').text('🔙 Menyu', 'back_main') });
    }
  }

  // Admin
  if (data === 'admin_stats') {
    if (!ADMIN_IDS.includes(userId)) return;
    const users = await getAllUsers();
    return ctx.editMessageText(`👑 *Admin statistika*\n\n👥 Foydalanuvchilar: ${users.length}`, { parse_mode: 'Markdown', reply_markup: adminMenu() });
  }

  if (data === 'admin_broadcast') {
    if (!ADMIN_IDS.includes(userId)) return;
    ctx.session.waitingFor = 'broadcast';
    return ctx.editMessageText('📢 Broadcast xabarini yozing:');
  }

  if (data === 'admin_block') {
    if (!ADMIN_IDS.includes(userId)) return;
    ctx.session.waitingFor = 'block_user';
    return ctx.editMessageText('🚫 Bloklash uchun Telegram ID kiriting:');
  }

  if (data === 'admin_unblock') {
    if (!ADMIN_IDS.includes(userId)) return;
    ctx.session.waitingFor = 'unblock_user';
    return ctx.editMessageText('✅ Blokdan chiqarish uchun Telegram ID kiriting:');
  }
});

// ============================================================
// MESSAGE HANDLER (TEXT)
// ============================================================
bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text.startsWith('/')) return; // commandlarni skip qil

  const user = await getUser(userId);
  if (!user || user.is_blocked) return ctx.reply('❌ Siz bloklangansiz.');

  const waiting = ctx.session.waitingFor;

  // Session based inputs
  if (waiting) {
    ctx.session.waitingFor = null;

    if (waiting === 'search') {
      await ctx.replyWithChatAction('typing');
      const results = await searchMessages(userId, text);
      if (!results.length) return ctx.reply('🔍 Hech narsa topilmadi.');
      let msg = `🔍 *"${text}" natijalari:*\n\n`;
      results.forEach((r, i) => {
        const date = new Date(r.created_at).toLocaleDateString('uz-UZ');
        const icon = r.role === 'user' ? '👤' : '🤖';
        msg += `${i + 1}. [${date}] ${icon} ${r.content.substring(0, 120)}...\n\n`;
      });
      return ctx.reply(msg, { parse_mode: 'Markdown' });
    }

    if (waiting === 'translate_text') {
      await ctx.replyWithChatAction('typing');
      const result = await aiTranslate(text, ctx.session.extra);
      ctx.session.extra = null;
      return ctx.reply(`🌐 *Tarjima:*\n\n${result}`, { parse_mode: 'Markdown' });
    }

    if (waiting === 'summarize') {
      await ctx.replyWithChatAction('typing');
      const result = await aiSummarize(text);
      return ctx.reply(`📝 *Xulosa:*\n\n${result}`, { parse_mode: 'Markdown' });
    }

    if (waiting === 'grammar') {
      await ctx.replyWithChatAction('typing');
      const result = await aiGrammar(text);
      return ctx.reply(`✏️ *Grammatika:*\n\n${result}`, { parse_mode: 'Markdown' });
    }

    if (waiting === 'story') {
      await ctx.replyWithChatAction('typing');
      const history = await getHistory(userId, 10);
      const result = await aiStory(text, history);
      await saveMessage(userId, 'user', `[HIKOYA] ${text}`);
      await saveMessage(userId, 'assistant', result);
      return ctx.reply(`📖 *Hikoya:*\n\n${result}`, { parse_mode: 'Markdown' });
    }

    if (waiting === 'quiz_topic') {
      await ctx.replyWithChatAction('typing');
      const quiz = await aiQuiz(text);
      if (!quiz) return ctx.reply('❌ Quiz yaratishda xato. Qayta urinib ko\'ring.');
      ctx.session.extra = { correct: quiz.correct, explanation: quiz.explanation };
      const kb = new InlineKeyboard();
      quiz.options.forEach((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        kb.text(opt, `quiz_ans_${letter}`);
        if (i % 2 === 1) kb.row();
      });
      return ctx.reply(`🧩 *Quiz:*\n\n${quiz.question}`, { parse_mode: 'Markdown', reply_markup: kb });
    }

    if (waiting === 'reminder') {
      const parts = text.split('|');
      if (parts.length !== 2) return ctx.reply('❌ Format: `Xabar | YYYY-MM-DD HH:MM`', { parse_mode: 'Markdown' });
      const [msg, dateStr] = parts.map(s => s.trim());
      const remindAt = new Date(dateStr);
      if (isNaN(remindAt.getTime())) return ctx.reply('❌ Sana noto\'g\'ri. Format: `YYYY-MM-DD HH:MM`', { parse_mode: 'Markdown' });
      await createReminder(userId, msg, remindAt.toISOString());
      return ctx.reply(`✅ Eslatma qo'yildi!\n📝 ${msg}\n⏰ ${remindAt.toLocaleString('uz-UZ')}`);
    }

    if (waiting === 'quiet_time') {
      const match = text.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
      if (!match) return ctx.reply('❌ Format: `HH:MM-HH:MM`', { parse_mode: 'Markdown' });
      await updateUser(userId, { quiet_start: match[1], quiet_end: match[2] });
      return ctx.reply(`✅ Tinch vaqt belgilandi: ${match[1]} - ${match[2]}`);
    }

    if (waiting === 'broadcast' && ADMIN_IDS.includes(userId)) {
      const users = await getAllUsers();
      let sent = 0;
      for (const u of users) {
        try {
          await bot.api.sendMessage(u.telegram_id, `📢 *Xabar:*\n\n${text}`, { parse_mode: 'Markdown' });
          sent++;
          await new Promise(r => setTimeout(r, 50));
        } catch {}
      }
      return ctx.reply(`✅ Broadcast yuborildi: ${sent}/${users.length} foydalanuvchi`);
    }

    if (waiting === 'block_user' && ADMIN_IDS.includes(userId)) {
      const targetId = parseInt(text);
      if (isNaN(targetId)) return ctx.reply('❌ Noto\'g\'ri ID');
      await updateUser(targetId, { is_blocked: true });
      return ctx.reply(`✅ Foydalanuvchi ${targetId} bloklandi.`);
    }

    if (waiting === 'unblock_user' && ADMIN_IDS.includes(userId)) {
      const targetId = parseInt(text);
      if (isNaN(targetId)) return ctx.reply('❌ Noto\'g\'ri ID');
      await updateUser(targetId, { is_blocked: false });
      return ctx.reply(`✅ Foydalanuvchi ${targetId} blokdan chiqarildi.`);
    }
  }

  // Oddiy suhbat
  await ctx.replyWithChatAction('typing');
  const mood = await aiMood(text);
  await saveMood(userId, mood);
  const history = await getHistory(userId, 15);
  const response = await aiChat(text, history, user);
  await saveMessage(userId, 'user', text, mood);
  await saveMessage(userId, 'assistant', response);
  await updateUser(userId, { message_count: (user.message_count || 0) + 1 });
  await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => ctx.reply(response));
});

// ============================================================
// PHOTO HANDLER
// ============================================================
bot.on('message:photo', async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (!user || user.is_blocked) return;

  await ctx.replyWithChatAction('typing');
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const caption = ctx.message.caption || '';

  try {
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(resp.data).toString('base64');
    const analysis = await aiAnalyzeImage(base64, caption, user);
    await savePhoto(userId, photo.file_id, caption, analysis);
    await ctx.reply(`🖼️ *Rasm tahlili:*\n\n${analysis}`, { parse_mode: 'Markdown' }).catch(() => ctx.reply(analysis));
  } catch (err) {
    console.error('Photo xatosi:', err.message);
    await ctx.reply('❌ Rasmni tahlil qilishda xato yuz berdi.');
  }
});

// ============================================================
// VOICE HANDLER
// ============================================================
bot.on('message:voice', async (ctx) => {
  if (!OPENAI_KEY) return ctx.reply('❌ Ovoz funksiyasi sozlanmagan (OPENAI_API_KEY kerak).');
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (!user || user.is_blocked) return;

  await ctx.replyWithChatAction('typing');

  try {
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const audioResp = await axios.get(fileUrl, { responseType: 'arraybuffer' });

    const formData = new FormData();
    formData.append('file', Buffer.from(audioResp.data), { filename: 'voice.ogg', contentType: 'audio/ogg' });
    formData.append('model', 'whisper-1');
    formData.append('language', user.language || 'uz');

    const whisper = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: { ...formData.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` }
    });

    const transcribed = whisper.data.text;
    if (!transcribed) return ctx.reply('❌ Ovozni tushunib bo\'lmadi.');

    await ctx.reply(`🎤 *Tanilgan matn:*\n_${transcribed}_`, { parse_mode: 'Markdown' });

    const history = await getHistory(userId, 15);
    const response = await aiChat(transcribed, history, user);
    await saveMessage(userId, 'user', `🎤 ${transcribed}`);
    await saveMessage(userId, 'assistant', response);
    await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => ctx.reply(response));
  } catch (err) {
    console.error('Voice xatosi:', err.message);
    await ctx.reply('❌ Ovozni qayta ishlashda xato.');
  }
});

// ============================================================
// DOCUMENT HANDLER
// ============================================================
bot.on('message:document', async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (!user || user.is_blocked) return;

  const doc = ctx.message.document;
  if (!['application/pdf', 'text/plain'].includes(doc.mime_type)) {
    return ctx.reply('❌ Faqat PDF va TXT fayllarni o\'qiy olaman.');
  }
  if (doc.file_size > 5 * 1024 * 1024) return ctx.reply('❌ Fayl 5MB dan kichik bo\'lishi kerak.');

  await ctx.replyWithChatAction('upload_document');

  try {
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const fileResp = await axios.get(fileUrl, { responseType: 'arraybuffer' });

    let text = '';
    if (doc.mime_type === 'application/pdf') {
      const pdf = await pdfParse(Buffer.from(fileResp.data));
      text = pdf.text;
    } else {
      text = Buffer.from(fileResp.data).toString('utf-8');
    }

    if (!text?.trim()) return ctx.reply('❌ Fayldan matn o\'qib bo\'lmadi.');

    await ctx.reply('📄 Fayl o\'qildi. Xulosa tayyorlanmoqda...');
    const summary = await aiSummarize(text.substring(0, 4000));
    await ctx.reply(`📄 *${doc.file_name || 'Fayl'}*\n\n📝 *Xulosa:*\n\n${summary}`, { parse_mode: 'Markdown' }).catch(() => ctx.reply(summary));
  } catch (err) {
    console.error('Document xatosi:', err.message);
    await ctx.reply('❌ Faylni qayta ishlashda xato.');
  }
});

// ============================================================
// REMINDER CRON (har daqiqada)
// ============================================================
cron.schedule('* * * * *', async () => {
  const { data: reminders } = await supabase.from('reminders').select('*')
    .eq('is_sent', false).lte('remind_at', new Date().toISOString());

  for (const rem of (reminders || [])) {
    try {
      await bot.api.sendMessage(rem.user_id, `⏰ *Eslatma!*\n\n${rem.message}`, { parse_mode: 'Markdown' });
      await supabase.from('reminders').update({ is_sent: true }).eq('id', rem.id);
    } catch (err) {
      console.error(`Eslatma xatosi (${rem.user_id}):`, err.message);
    }
  }
});

// ============================================================
// ERROR HANDLER & START
// ============================================================
bot.catch((err) => {
  console.error('Bot xatosi:', err.message);
});

bot.start();
console.log('🤖 Bot muvaffaqiyatli ishga tushdi!');
