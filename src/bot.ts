import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { VectorStore } from './vectorStore';

dotenv.config({ override: true });

const botToken = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN)?.trim();
const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseKey = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();

console.log('Используемый API-ключ Gemini:', geminiApiKey ? `${geminiApiKey.slice(0, 6)}...${geminiApiKey.slice(-6)} (длина ${geminiApiKey.length})` : 'ОТСУТСТВУЕТ');

let bot: Telegraf;
let genAI: GoogleGenerativeAI;
let vectorStore: VectorStore;
const dataDir = path.join(__dirname, '../data');

if (!botToken || !geminiApiKey || !supabaseUrl || !supabaseKey) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Отсутствуют переменные окружения BOT_TOKEN, GEMINI_API_KEY, SUPABASE_URL или SUPABASE_KEY!");
  setInterval(() => {
    console.log("Контейнер удерживается активным. Проверь переменные окружения в панели Coolify!");
  }, 10000);
} else {
  bot = new Telegraf(botToken);
  genAI = new GoogleGenerativeAI(geminiApiKey);
  vectorStore = new VectorStore(geminiApiKey, supabaseUrl, supabaseKey);
}

// Хранилище сессий для контекста диалога (in-memory)
const sessions: { [chatId: number]: { role: string; parts: { text: string }[] }[] } = {};

async function startBot() {
  if (!bot) return;
  await vectorStore.loadFromDirectory(dataDir);

  bot.start((ctx) => {
    const chatId = ctx.chat.id;
    sessions[chatId] = []; // Очищаем историю при старте
    ctx.reply('Привет! Я AI-ассистент Centr-Krasok. Что тебя интересует? (Услуги, адреса, каталог)');
  });

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;

    try {
      // Инициализируем историю, если её нет
      if (!sessions[chatId]) {
        sessions[chatId] = [];
      }

      // Формируем обогащенный запрос для поиска на основе контекста диалога
      let searchQuery = userText;
      if (sessions[chatId] && sessions[chatId].length > 0) {
        const userHistory = sessions[chatId]
          .filter(m => m.role === 'user')
          .map(m => m.parts[0].text);
        if (userHistory.length > 0) {
          searchQuery = `${userHistory[userHistory.length - 1]} ${userText}`;
        }
      }

      // Ищем релевантный контекст по обогащенному запросу
      const relevantChunks = await vectorStore.search(searchQuery, 3);

      let contextText = "Нет данных.";
      if (relevantChunks.length > 0) {
        contextText = relevantChunks.map(c => `[Источник: ${c.sourceFile}]\n${c.text}`).join('\n\n');
      }

      const systemPrompt = `
Ты — профессиональная, умная и обаятельная девушка-консультант (AI-ассистент) компании "Центр Красок №1".
Твоя задача — помогать клиентам с выбором товаров, отвечать на вопросы о наличии, ценах и характеристиках.

Говори от женского лица (используй женские глаголы и окончания: "готова помочь", "посмотрела", "посоветовала бы" и т.д.). Общайся дружелюбно, вежливо и вовлекающе.

Контекст из базы знаний:
${contextText}

ИНСТРУКЦИИ ПО ДИАЛОГУ И КОНТЕКСТУ:
1. Опирайся на предоставленный контекст базы знаний.
2. ИСПОЛЬЗУЙ ИСТОРИЮ ДИАЛОГА для связи контекста! Если пользователь задает уточняющий вопрос (например: "а сейчас?", "сколько стоит?", "а есть другой цвет?", "какой остаток?"), пойми из истории переписки, о каком именно товаре идет речь, и ответь на основе характеристик этого товара из истории или предоставленного контекста. Не тупи и не говори "я не нашел информацию", если этот товар обсуждался строкой выше!
3. Ты можешь поддерживать легкий, непринужденный диалог (спросить "как дела?", пошутить, ответить на простые вежливые реплики), но ОБЯЗАТЕЛЬНО мягко переводи разговор на наши товары, помощь в подборе краски, оформление покупки или предложи переключить на менеджера. Каждая твоя реплика должна вести клиента к сделке или целевому действию!
4. Если ответа действительно нет ни в истории, ни в контексте, вежливо скажи: "К сожалению, я не нашла этой информации. Хотите, я переключу вас на нашего менеджера?"
5. Отвечай кратко, профессионально и по делу.
6. НИКОГДА не используй символы * или ** для форматирования. Пиши чистым текстом.
7. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО называть точные цифры остатков (например, "1391 шт"). Если остаток > 0, говори "Да, товар есть в наличии". Если 0 или товара нет в контексте, говори "К сожалению, сейчас этого товара нет в наличии".
8. ОБЯЗАТЕЛЬНО называй цену товара в KZT, если она есть в контексте или истории обсуждения этого товара.
9. ЗАПРЕЩЕНО здороваться в каждом сообщении. Поприветствуй пользователя только один раз в начале диалога.
`;


      const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash",
        systemInstruction: systemPrompt
      });

      // Добавляем сообщение пользователя в историю
      sessions[chatId].push({ role: 'user', parts: [{ text: userText }] });

      // Запускаем генерацию с учетом истории
      const result = await model.generateContent({
        contents: sessions[chatId]
      });

      let replyText = result.response.text() || "Ошибка генерации.";

      // Программная очистка от звездочек
      replyText = replyText.replace(/\*/g, '');

      // Добавляем ответ модели в историю
      sessions[chatId].push({ role: 'model', parts: [{ text: replyText }] });

      // Ограничиваем историю последних 8 сообщений
      if (sessions[chatId].length > 8) {
        sessions[chatId] = sessions[chatId].slice(sessions[chatId].length - 8);
      }

      await ctx.reply(replyText);

    } catch (error) {
      console.error("Bot Error:", error);
      await ctx.reply("Произошла ошибка. Попробуй позже.");
    }
  });

  bot.launch()
    .then(() => console.log('🤖 Бот с Local RAG успешно запущен!'))
    .catch(err => console.error('Ошибка запуска:', err));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

startBot().catch(err => {
  console.error("КРИТИЧЕСКАЯ ОШИБКА СТАРТА БОТА:", err);
  setInterval(() => {
    console.log("Контейнер удерживается активным для диагностики...");
  }, 10000);
});
