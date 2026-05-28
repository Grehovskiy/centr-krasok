import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://centr-krasok.kz';
const DATA_DIR = path.join(__dirname, '../data');

// Создаем папку data, если ее нет
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Утилита для очистки текста
function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\n\t]/g, ' ')
    .trim();
}

async function fetchPage(url: string): Promise<string> {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    
    // Удаляем скрипты, стили, шапку, подвал
    $('script, style, nav, footer, header, noscript').remove();
    
    return cleanText($('body').text());
  } catch (error) {
    console.error(`Ошибка при парсинге ${url}:`, error);
    return '';
  }
}

async function runParser() {
  console.log('Начинаю парсинг сайта...');

  // Главная страница
  const mainText = await fetchPage(BASE_URL);
  fs.writeFileSync(path.join(DATA_DIR, 'about.txt'), mainText);
  console.log('✅ Сохранено: about.txt');

  // Контакты (пример, если у них есть такой URL)
  const contactsText = await fetchPage(`${BASE_URL}/contacts/`);
  fs.writeFileSync(path.join(DATA_DIR, 'contacts.txt'), contactsText);
  console.log('✅ Сохранено: contacts.txt');

  // Услуги / Каталог (примеры ссылок, подставь нужные)
  const catalogText = await fetchPage(`${BASE_URL}/catalog/`);
  fs.writeFileSync(path.join(DATA_DIR, 'products.txt'), catalogText);
  console.log('✅ Сохранено: products.txt');

  console.log('Парсинг завершен! Векторная база будет использовать эти файлы.');
}

runParser();
