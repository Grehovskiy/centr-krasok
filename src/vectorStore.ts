
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import ws from 'ws';

interface Chunk {
  text: string;
  sourceFile: string;
}

export class VectorStore {
  private extractor: any = null;
  private supabase: SupabaseClient;

  constructor(geminiApiKey: string, supabaseUrl: string, supabaseKey: string) {
    // geminiApiKey больше не нужен, но оставляем в конструкторе, чтобы не ломать bot.ts
    this.supabase = createClient(supabaseUrl, supabaseKey, {
      realtime: { transport: ws }
    });
  }

  private async getExtractor() {
    if (!this.extractor) {
      console.log('Загрузка модели Xenova/paraphrase-multilingual-mpnet-base-v2 (768 вектор)...');
      const { pipeline } = await import('@xenova/transformers');
      this.extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-mpnet-base-v2');
    }
    return this.extractor;
  }

  private async getEmbedding(text: string, isQuery = false): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  // Загрузка и нарезка текстовых файлов
  public async loadFromDirectory(dirPath: string) {
    console.log(`Сканирую директорию: ${dirPath}`);
    if (!fs.existsSync(dirPath)) {
      console.warn('Папка data пуста или не существует. Запусти парсер!');
      return;
    }

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));

    for (const file of files) {
      // Проверяем, есть ли уже этот файл в базе
      const { data: existingData, error: countError } = await this.supabase
        .from('center_karasok_bot_documents')
        .select('id')
        .eq('source_file', file)
        .limit(1);

      if (countError) {
        console.error(`Ошибка проверки файла ${file}:`, countError);
        continue;
      }

      if (existingData && existingData.length > 0) {
        console.log(`Файл ${file} уже есть в базе. Пропускаем.`);
        continue;
      }

      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const chunkTexts = this.splitIntoChunks(content, 700);

      console.log(`Векторизация файла ${file} (${chunkTexts.length} чанков)...`);

      for (const text of chunkTexts) {
        if (text.trim().length < 50) continue; // пропускаем мусор

        try {
          const embedding = await this.getEmbedding(text, false);

          const { error } = await this.supabase
            .from('center_karasok_bot_documents')
            .insert({
              content: text,
              source_file: file,
              embedding
            });

          if (error) {
            console.error('Ошибка записи вектора в Supabase:', error);
          }
        } catch (error) {
          console.error('Ошибка получения вектора:', error);
        }
      }
    }
    console.log(`✅ Синхронизация с Supabase завершена.`);
  }

  // Поиск ближайших векторов
  public async search(query: string, topK: number = 3): Promise<Chunk[]> {
    try {
      const queryEmbedding = await this.getEmbedding(query, true);

      const { data, error } = await this.supabase.rpc('match_center_karasok_bot_documents', {
        query_embedding: queryEmbedding,
        match_threshold: 0.5, // Порог сходства
        match_count: topK
      });

      if (error) {
        console.error('Ошибка RPC поиска:', error);
        return [];
      }

      return data.map((d: any) => ({
        text: d.content,
        sourceFile: d.source_file
      }));
    } catch (error) {
      console.error('Ошибка поиска:', error);
      return [];
    }
  }

  // Вспомогательные функции
  private splitIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    const overlap = 250;

    let i = 0;
    while (i < text.length) {
      const chunk = text.slice(i, i + chunkSize);
      chunks.push(chunk);
      i += (chunkSize - overlap);
      if (i + overlap >= text.length) break;
    }
    return chunks;
  }
}
