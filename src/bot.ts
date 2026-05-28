import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { VectorStore } from './vectorStore';

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!botToken || !geminiApiKey) {
  console.error("Ошибка: Укажи TELEGRAM_BOT_TOKEN и GEMINI_API_KEY в .env");
  process.exit(1);
}

const bot = new Telegraf(botToken);
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Инициализация Векторной Базы
const vectorStore = new VectorStore(geminiApiKey);
const dataDir = path.join(__dirname, '../data');

async function startBot() {
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

Если ответа в контексте нет, честно скажи: "К сожалению, я не нашел этой информации."
Отвечай вежливо и кратко.
`;

      const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash",
        systemInstruction: systemPrompt
      });

      const result = await model.generateContent(userText);
      const replyText = result.response.text() || "Ошибка генерации.";

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

startBot();
