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

console.log('Gemini API key:', geminiApiKey ? `${geminiApiKey.slice(0, 6)}...${geminiApiKey.slice(-6)} (length ${geminiApiKey.length})` : 'missing');

let bot: Telegraf;
let genAI: GoogleGenerativeAI;
let vectorStore: VectorStore;
const dataDir = path.join(__dirname, '../data');

if (!botToken || !geminiApiKey || !supabaseUrl || !supabaseKey) {
  console.error('Critical error: missing BOT_TOKEN, GEMINI_API_KEY, SUPABASE_URL or SUPABASE_KEY.');
  setInterval(() => {
    console.log('Container is alive. Check environment variables in Coolify.');
  }, 10000);
} else {
  bot = new Telegraf(botToken);
  genAI = new GoogleGenerativeAI(geminiApiKey);
  vectorStore = new VectorStore(geminiApiKey, supabaseUrl, supabaseKey);
}

const sessions: { [chatId: number]: { role: string; parts: { text: string }[] }[] } = {};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTelegramReply(text: string): string {
  const escapedText = escapeHtml(text);
  const linkRegex = /Ссылка:\s*(https?:\/\/[^\s<]+)/g;
  return escapedText.replace(linkRegex, 'Подробнее: <a href="$1">карточка товара</a>');
}

function getLineValue(text: string, label: string): string | null {
  const line = text
    .split('\n')
    .find(item => item.trim().startsWith(label));

  return line ? line.slice(label.length).trim() : null;
}

function isDiscountQuery(text: string): boolean {
  const normalized = text.toLowerCase().replace(/ё/g, 'е');
  return normalized.includes('скид') || normalized.includes('акци') || normalized.includes('распродаж');
}

function buildFallbackReply(chunks: { text: string }[], mode: 'products' | 'discounts' = 'products'): string {
  const products = chunks
    .map(chunk => ({
      title: getLineValue(chunk.text, 'Товар:'),
      price: getLineValue(chunk.text, 'Цена:'),
      link: getLineValue(chunk.text, 'Ссылка:')
    }))
    .filter(product => product.title && product.price)
    .slice(0, 5);

  if (products.length === 0) {
    return 'Нашел похожие позиции в базе, но сейчас не смог красиво собрать ответ. Лучше передам менеджеру, он быстро проверит цену и наличие.';
  }

  const lines = [
    mode === 'discounts'
      ? 'Да, есть товары со скидкой. Вот несколько актуальных вариантов:'
      : 'Нашел в базе такие варианты:'
  ];

  for (const [index, product] of products.entries()) {
    lines.push('');
    lines.push(`${index + 1}. ${product.title}`);
    lines.push(`Цена: ${product.price}`);
    if (product.link) {
      lines.push(`Ссылка: ${product.link}`);
    }
  }

  lines.push('');
  lines.push(
    mode === 'discounts'
      ? 'Акционных позиций больше — могу передать менеджеру, чтобы он подобрал самые выгодные варианты под вашу задачу.'
      : 'Ассортимент больше — могу передать менеджеру, чтобы подобрать точный вариант под задачу.'
  );
  return lines.join('\n');
}

async function startBot() {
  if (!bot) return;
  await vectorStore.loadFromDirectory(dataDir);

  bot.start((ctx) => {
    const chatId = ctx.chat.id;
    sessions[chatId] = [];
    ctx.reply('Привет! Я AI-ассистент Центра красок №1. Что Вас интересует?');
  });

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;

    try {
      if (!sessions[chatId]) {
        sessions[chatId] = [];
      }

      let searchQuery = userText;
      if (sessions[chatId] && sessions[chatId].length > 0) {
        const userHistory = sessions[chatId]
          .filter(m => m.role === 'user')
          .map(m => m.parts[0].text);
        if (userHistory.length > 0) {
          searchQuery = `${userHistory[userHistory.length - 1]} ${userText}`;
        }
      }

      const discountQuery = isDiscountQuery(userText);
      const relevantChunks = discountQuery
        ? await vectorStore.searchDiscounts(5)
        : await vectorStore.search(searchQuery, 5);

      if (relevantChunks.length === 0) {
        const replyText = 'Не нашел точных товаров в базе по вашему запросу. Лучше передам менеджеру, чтобы он быстро проверил наличие и цену.';
        sessions[chatId].push({ role: 'user', parts: [{ text: userText }] });
        sessions[chatId].push({ role: 'model', parts: [{ text: replyText }] });

        if (sessions[chatId].length > 8) {
          sessions[chatId] = sessions[chatId].slice(sessions[chatId].length - 8);
        }

        await ctx.reply(formatTelegramReply(replyText), { parse_mode: 'HTML' });
        return;
      }

      const contextText = relevantChunks
        .map(c => `[Источник: ${c.sourceFile}]\n${c.text}`)
        .join('\n\n');

      const systemPrompt = `
Ты — AI-консультант "Центр Красок №1".

Данные:
${contextText}

ПРАВИЛА:
1. Отвечай только на основе предоставленного контекста.
2. Если в контексте есть строки "Товар:" и "Цена:" — перечисли до 5 подходящих товаров с ценами в KZT. Если найдено 5 товаров, покажи все 5. Если найдено меньше — покажи все найденные.
3. Не говори, что товара нет, если в контексте есть похожие варианты. Для запроса "глянцевая краска" варианты "п/глянц", "полуглянцевая" и "глянц" считаются релевантными. Скажи честно: "Есть полуглянцевые варианты".
4. Менеджера предлагай только после списка товаров или когда в контексте вообще нет подходящих товаров.
5. Запрещено:
   - Использовать символы * и **.
   - Называть точные цифры остатков.
   - Здороваться в каждом сообщении.
   - Давать общие рассуждения вместо товаров и цен.
6. Если у товара есть ссылка, можешь написать ее строкой "Ссылка: URL" — код сам красиво оформит ее в Telegram.
7. Если вопрос про скидки, акции или распродажу — отвечай только про товары со старой ценой. Не пиши фразу про ассортимент; вместо этого напиши: "Акционных позиций больше — могу передать менеджеру, чтобы он подобрал самые выгодные варианты под вашу задачу."
8. Для обычного товарного подбора после списка добавляй короткую фразу: "Ассортимент больше — могу передать менеджеру, чтобы подобрать точный вариант под задачу."
9. Отвечай кратко, профессионально и по делу.

Цель — помочь купить: показать варианты, цену и предложить оформить или уточнить у менеджера.
`;

      const model = genAI.getGenerativeModel({
        model: 'gemini-3.5-flash',
        systemInstruction: systemPrompt
      });

      sessions[chatId].push({ role: 'user', parts: [{ text: userText }] });

      let replyText: string;
      try {
        const result = await model.generateContent({
          contents: sessions[chatId]
        });

        replyText = result.response.text() || buildFallbackReply(relevantChunks, discountQuery ? 'discounts' : 'products');
      } catch (error) {
        console.error('Gemini Error, using catalog fallback:', error);
        replyText = buildFallbackReply(relevantChunks, discountQuery ? 'discounts' : 'products');
      }

      replyText = replyText.replace(/\*/g, '');
      sessions[chatId].push({ role: 'model', parts: [{ text: replyText }] });

      if (sessions[chatId].length > 8) {
        sessions[chatId] = sessions[chatId].slice(sessions[chatId].length - 8);
      }

      await ctx.reply(formatTelegramReply(replyText), { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Bot Error:', error);
      await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
  });

  bot.launch()
    .then(() => console.log('Bot with Local RAG started successfully.'))
    .catch(err => console.error('Launch error:', err));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

startBot().catch(err => {
  console.error('Critical bot start error:', err);
  setInterval(() => {
    console.log('Container is alive for diagnostics.');
  }, 10000);
});
