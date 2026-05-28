import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://centr-krasok.kz';
const DATA_DIR = path.join(__dirname, '../data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\n\t]/g, ' ').trim();
}

async function fetchProducts(baseUrl: string): Promise<string> {
  try {
    let result = '';
    const links: string[] = [];
    let page = 1;

    console.log('Собираю все ссылки со всех страниц каталога...');

    // Пагинация: идем по страницам, пока товары не кончатся
    while (true) {
      const url = `${baseUrl}?PAGEN_1=${page}`;
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);
      
      const productCards = $('.product-item, .catalog-item, .product-card, .item'); 
      if (productCards.length === 0) {
        break; // Страницы кончились
      }

      let addedOnPage = 0;
      productCards.each((_, el) => {
        let href = $(el).find('a').first().attr('href') || '';
        if (href && !href.startsWith('http')) href = BASE_URL + href;
        if (href && !links.includes(href)) {
          links.push(href);
          addedOnPage++;
        }
      });

      if (addedOnPage === 0) break; // Защита от вечного цикла
      console.log(`Страница ${page}: собрано ссылок - ${addedOnPage}`);
      page++;
    }

    console.log(`Итого найдено уникальных товаров: ${links.length}. Начинаю обход (по 20 штук одновременно)...`);

    // Функция парсинга одного товара
    const processLink = async (link: string) => {
      try {
        const itemRes = await axios.get(link);
        const item$ = cheerio.load(itemRes.data);

        let title = cleanText(item$('h1').text());

        let currentPrice = cleanText(item$('.detail_item_price_current, .price').text());
        let oldPrice = cleanText(item$('.detail_item_price_old, .old-price').text());
        let price = currentPrice || 'По запросу';
        if (oldPrice) price = `${currentPrice} (старая цена: ${oldPrice})`;

        let description = cleanText(item$('.detail_text_inner, .product-description').text());

        let props = new Set<string>();
        item$('.detail_item_props li').each((_, propEl) => {
          let name = cleanText(item$(propEl).find('strong').text());
          let val = cleanText(item$(propEl).find('span').text());
          if (name && val) props.add(`${name}: ${val}`);
        });

        let stock = new Set<string>();
        item$('.detail_item_amount_store').each((_, stockEl) => {
          stock.add(cleanText(item$(stockEl).text()));
        });

        let src = item$('.product-item-detail-slider-image img, .detail_picture img, .product-img img, .main-img').attr('src') || '';
        if (src && !src.startsWith('http')) src = BASE_URL + src;

        if (title) {
          let itemText = `Товар: ${title}\nЦена: ${price}\nСсылка: ${link}\nКартинка: ${src}\n`;
          if (stock.size > 0) itemText += `Наличие: ${Array.from(stock).join(' | ')}\n`;
          if (props.size > 0) itemText += `Характеристики: ${Array.from(props).join('; ')}\n`;
          if (description) itemText += `Описание: ${description}\n`;
          itemText += `---\n`;
          
          console.log(`Спарсер: ${title}`);
          return itemText;
        }
      } catch (err) {
        console.error(`Ошибка при заходе в товар ${link}`);
      }
      return '';
    };

    // Запускаем асинхронно пачками по 20 штук за раз
    const BATCH_SIZE = 20;
    for (let i = 0; i < links.length; i += BATCH_SIZE) {
      const batch = links.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(processLink));
      result += batchResults.join('');
    }

    return result;
  } catch (error) {
    console.error(`Ошибка при парсинге каталога:`, error);
    return '';
  }
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, noscript').remove();
    return cleanText($('body').text());
  } catch (error) {
    return '';
  }
}

async function runParser() {
  console.log('Начинаю сбор данных...');

  const mainText = await fetchPageText(BASE_URL);
  fs.writeFileSync(path.join(DATA_DIR, 'about.txt'), mainText);
  console.log('✅ Сохранено: about.txt');

  const contactsText = await fetchPageText(`${BASE_URL}/contacts/`);
  fs.writeFileSync(path.join(DATA_DIR, 'contacts.txt'), contactsText);
  console.log('✅ Сохранено: contacts.txt');

  console.log('Парсинг каталога с извлечением ссылок...');
  const catalogText = await fetchProducts(`${BASE_URL}/catalog/`);
  fs.writeFileSync(path.join(DATA_DIR, 'products.txt'), catalogText);
  console.log('✅ Сохранено: products.txt');

  console.log('Парсинг завершен! Теперь можно запускать npm run dev.');
}

runParser();
