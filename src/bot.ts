import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { VectorStore } from './vectorStore';

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

let bot: Telegraf;
let genAI: GoogleGenerativeAI;
let vectorStore: VectorStore;
const dataDir = path.join(__dirname, '../data');

if (!botToken || !geminiApiKey) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Отсутствуют переменные окружения TELEGRAM_BOT_TOKEN (или BOT_TOKEN) или GEMINI_API_KEY!");
  setInterval(() => {
    console.log("Контейнер удерживается активным. Проверь переменные окружения в панели Coolify!");
  }, 10000);
} else {
  bot = new Telegraf(botToken);
  genAI = new GoogleGenerativeAI(geminiApiKey);
  vectorStore = new VectorStore(geminiApiKey);
}

async function startBot() {
  if (!bot) return;
  await vectorStore.loadFromDirectory(dataDir);

  bot.start((ctx) => {
    ctx.reply('Привет! Я AI-ассистент Centr-Krasok. Что тебя интересует? (Услуги, адреса, каталог)');
  });

  bot.on(message('text'), async (ctx) => {
    const userText = ctx.message.text;

    try {
      // Ищем релевантный контекст
      const relevantChunks = await vectorStore.search(userText, 3);

      let contextText = "Нет данных.";
      if (relevantChunks.length > 0) {
        contextText = relevantChunks.map(c => `[Источник: ${c.sourceFile}]\n${c.text}`).join('\n\n');
      }

      const systemPrompt = `
Ты полезный AI-ассистент компании Centr-Krasok. 
Отвечай на вопросы пользователя ТОЛЬКО на основе следующего контекста из базы знаний:

${contextText}

Если ответа в контексте нет, вежливо извинись и скажи: "К сожалению, я не нашел этой информации. Хотите, я переключу вас на нашего менеджера?"
Отвечай вежливо и кратко.
НИКОГДА не используй символы * или ** для форматирования и выделения текста жирным. Пиши только чистым текстом без разметки Markdown.
`;

      const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash",
        systemInstruction: systemPrompt
      });

      const result = await model.generateContent(userText);
      let replyText = result.response.text() || "Ошибка генерации.";
      
      // Программная очистка от звездочек
      replyText = replyText.replace(/\*/g, '');

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
