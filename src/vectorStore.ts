import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

interface Chunk {
  text: string;
  sourceFile: string;
  embedding: number[];
}

export class VectorStore {
  private chunks: Chunk[] = [];
  private genAI: GoogleGenerativeAI;
  private embeddingModel: any;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.embeddingModel = this.genAI.getGenerativeModel({ model: "gemini-embedding-001" });
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
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      
      // Уменьшаем размер чанка до 700 символов для более точного поиска
      const chunkTexts = this.splitIntoChunks(content, 700);
      
      console.log(`Векторизация файла ${file} (${chunkTexts.length} чанков)...`);
      
      for (const text of chunkTexts) {
        if (text.trim().length < 50) continue; // пропускаем мусор
        
        try {
          const result = await this.embeddingModel.embedContent(text);
          const embedding = result.embedding.values;
          
          this.chunks.push({
            text,
            sourceFile: file,
            embedding
          });
        } catch (error) {
          console.error('Ошибка получения вектора:', error);
        }
      }
    }
    console.log(`✅ Векторная база загружена. Всего чанков: ${this.chunks.length}`);
  }

  // Поиск ближайших векторов
  public async search(query: string, topK: number = 3): Promise<Chunk[]> {
    if (this.chunks.length === 0) return [];

    try {
      const result = await this.embeddingModel.embedContent(query);
      const queryEmbedding = result.embedding.values;

      // Считаем косинусное сходство
      const scoredChunks = this.chunks.map(chunk => ({
        chunk,
        score: this.cosineSimilarity(queryEmbedding, chunk.embedding)
      }));

      // Сортируем по убыванию
      scoredChunks.sort((a, b) => b.score - a.score);

      return scoredChunks.slice(0, topK).map(s => s.chunk);
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
      if (i + overlap >= text.length) break; // избегаем слишком маленьких чанков на конце
    }
    return chunks;
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
