import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws');

interface Chunk {
  text: string;
  sourceFile: string;
}

interface ScoredChunk extends Chunk {
  score: number;
}

export class VectorStore {
  private extractor: any = null;
  private supabase: SupabaseClient;
  private readonly stopWords = new Set([
    '\u0435\u0441\u0442\u044c',
    '\u0438\u043b\u0438',
    '\u0434\u043b\u044f',
    '\u0447\u0442\u043e',
    '\u043a\u0430\u043a',
    '\u0433\u0434\u0435',
    '\u044d\u0442\u043e',
    '\u0446\u0435\u043d\u0443',
    '\u0446\u0435\u043d\u0430',
    '\u0441\u0442\u043e\u0438\u0442',
    '\u0441\u043a\u043e\u043b\u044c\u043a\u043e',
    '\u0432\u0430\u0436\u043d\u043e',
    '\u043d\u0443\u0436\u043d\u043e',
    '\u043d\u0430\u0434\u043e',
    '\u043c\u043e\u0436\u043d\u043e',
    '\u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430'
  ]);

  constructor(geminiApiKey: string, supabaseUrl: string, supabaseKey: string) {
    // geminiApiKey is kept for constructor compatibility with bot.ts.
    this.supabase = createClient(supabaseUrl, supabaseKey, {
      realtime: { transport: ws }
    });
  }

  private async getExtractor() {
    if (!this.extractor) {
      console.log('Loading Xenova/paraphrase-multilingual-mpnet-base-v2 embedding model...');
      const { pipeline } = await import('@xenova/transformers');
      this.extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-mpnet-base-v2');
    }
    return this.extractor;
  }

  private async getEmbedding(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  public async loadFromDirectory(dirPath: string) {
    console.log(`Scanning data directory: ${dirPath}`);
    if (!fs.existsSync(dirPath)) {
      console.warn('Data directory does not exist. Run the parser first.');
      return;
    }

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const chunkTexts = this.splitIntoChunks(content, 700);

      if (chunkTexts.length === 0) {
        console.log(`File ${file} has no chunks. Skipping.`);
        continue;
      }

      const { count: existingCount, error: countError } = await this.supabase
        .from('center_karasok_bot_documents')
        .select('id', { count: 'exact', head: true })
        .eq('source_file', file);

      if (countError) {
        console.error(`Failed to check indexed chunks for ${file}:`, countError);
        continue;
      }

      if (existingCount === chunkTexts.length) {
        console.log(`File ${file} is already indexed (${existingCount} chunks). Skipping.`);
        continue;
      }

      if (existingCount && existingCount > 0) {
        console.warn(`File ${file} index is stale or incomplete (${existingCount}/${chunkTexts.length}). Rebuilding.`);
        const { error: deleteError } = await this.supabase
          .from('center_karasok_bot_documents')
          .delete()
          .eq('source_file', file);

        if (deleteError) {
          console.error(`Failed to delete stale chunks for ${file}:`, deleteError);
          continue;
        }
      }

      console.log(`Vectorizing ${file} (${chunkTexts.length} chunks)...`);

      for (const text of chunkTexts) {
        if (text.trim().length < 50) continue;

        try {
          const embedding = await this.getEmbedding(text);

          const { error } = await this.supabase
            .from('center_karasok_bot_documents')
            .insert({
              content: text,
              source_file: file,
              embedding
            });

          if (error) {
            console.error('Failed to insert vector into Supabase:', error);
          }
        } catch (error) {
          console.error('Failed to create embedding:', error);
        }
      }
    }

    console.log('Supabase sync finished.');
  }

  public async search(query: string, topK: number = 3): Promise<Chunk[]> {
    const keywordMatches = await this.keywordSearch(query, Math.max(topK * 4, 20));

    try {
      const queryEmbedding = await this.getEmbedding(query);

      const { data, error } = await this.supabase.rpc('match_center_karasok_bot_documents', {
        query_embedding: queryEmbedding,
        match_threshold: 0.18,
        match_count: Math.max(topK * 8, 40)
      });

      if (error) {
        console.error('RPC search failed:', error);
        return keywordMatches.slice(0, topK);
      }

      const vectorMatches = (data || []).map((d: any) => ({
        text: d.content,
        sourceFile: d.source_file
      }));

      const mergedMatches = this.mergeChunks(keywordMatches, vectorMatches)
        .map(chunk => ({ ...chunk, score: this.scoreChunk(query, chunk.text) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      if (mergedMatches.length === 0) {
        console.warn(`No RAG matches for query: "${query}"`);
      }

      return mergedMatches.map(({ text, sourceFile }) => ({ text, sourceFile }));
    } catch (error) {
      console.error('Search failed:', error);
      return keywordMatches.slice(0, topK);
    }
  }

  public async searchDiscounts(topK: number = 5): Promise<Chunk[]> {
    const { data, error } = await this.supabase
      .from('center_karasok_bot_documents')
      .select('content, source_file')
      .ilike('content', '%старая цена:%')
      .limit(Math.max(topK * 4, 20));

    if (error) {
      console.error('Discount search failed:', error);
      return [];
    }

    return (data || [])
      .map((d: any): Chunk => ({
        text: d.content,
        sourceFile: d.source_file
      }))
      .filter(chunk => chunk.text.includes('Товар:') && chunk.text.includes('Цена:'))
      .slice(0, topK);
  }

  private async keywordSearch(query: string, limit: number): Promise<Chunk[]> {
    const terms = this.getSearchTerms(query);

    if (terms.length === 0) {
      return [];
    }

    let request = this.supabase
      .from('center_karasok_bot_documents')
      .select('content, source_file')
      .limit(80);

    for (const term of terms.slice(0, 4)) {
      request = request.ilike('content', `%${term}%`);
    }

    const { data, error } = await request;

    if (error) {
      console.error('Keyword search failed:', error);
      return [];
    }

    return (data || [])
      .map((d: any): ScoredChunk => ({
        text: d.content,
        sourceFile: d.source_file,
        score: this.scoreChunk(query, d.content)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ text, sourceFile }) => ({ text, sourceFile }));
  }

  private getSearchTerms(query: string): string[] {
    const normalizedQuery = query.toLowerCase().replace(/\u0451/g, '\u0435');
    const priorityTerms: string[] = [];

    if (normalizedQuery.includes('\u0433\u043b\u044f\u043d')) {
      priorityTerms.push('\u0433\u043b\u044f\u043d\u0446');
    }

    if (normalizedQuery.includes('\u043a\u0440\u0430\u0441\u043a')) {
      priorityTerms.push('\u043a\u0440\u0430\u0441\u043a');
    }

    const terms = normalizedQuery
      .split(/[^\p{L}0-9]+/u)
      .map(term => this.normalizeSearchTerm(term))
      .filter(term => term.length >= 4 && !this.stopWords.has(term));

    return Array.from(new Set([...priorityTerms, ...terms]));
  }

  private normalizeSearchTerm(term: string): string {
    if (term.startsWith('\u0433\u043b\u044f\u043d')) return '\u0433\u043b\u044f\u043d\u0446';
    if (term.startsWith('\u043a\u0440\u0430\u0441\u043a')) return '\u043a\u0440\u0430\u0441\u043a';
    if (term.startsWith('\u043d\u0430\u0440\u0443\u0436')) return '\u043d\u0430\u0440\u0443\u0436\u043d';
    if (term.startsWith('\u0444\u0430\u0441\u0430\u0434')) return '\u0444\u0430\u0441\u0430\u0434';
    if (term.startsWith('\u043c\u0430\u0442\u043e\u0432')) return '\u043c\u0430\u0442\u043e\u0432';
    if (term.startsWith('\u043b\u0430\u043a\u043e\u0432') || term.startsWith('\u043b\u0430\u043a\u0438')) return '\u043b\u0430\u043a';
    if (term.startsWith('\u044d\u043c\u0430\u043b')) return '\u044d\u043c\u0430\u043b';
    return term;
  }

  private scoreChunk(query: string, text: string): number {
    const terms = this.getSearchTerms(query);
    const lowerText = text.toLowerCase().replace(/\u0451/g, '\u0435');
    const title = lowerText.split('\n')[0] || '';
    let score = title.startsWith('\u0442\u043e\u0432\u0430\u0440:') ? 10 : -12;

    for (const term of terms) {
      if (!lowerText.includes(term)) continue;
      score += 1;
      if (title.includes(term)) score += 4;
    }

    if (terms.includes('\u043a\u0440\u0430\u0441\u043a')) {
      if (title.includes('\u043a\u0440\u0430\u0441\u043a') || lowerText.includes('\u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f \u0442\u043e\u0432\u0430\u0440\u0430: \u043a\u0440\u0430\u0441\u043a\u0430')) {
        score += 8;
      } else {
        score -= 50;
      }
    }

    if (terms.includes('\u043d\u0430\u0440\u0443\u0436\u043d') || terms.includes('\u0444\u0430\u0441\u0430\u0434')) {
      if (
        lowerText.includes('\u0442\u0438\u043f \u0440\u0430\u0431\u043e\u0442: \u0434\u043b\u044f \u043d\u0430\u0440\u0443\u0436\u043d\u044b\u0445 \u0440\u0430\u0431\u043e\u0442') ||
        lowerText.includes('\u0442\u0438\u043f \u0440\u0430\u0431\u043e\u0442: \u0434\u043b\u044f \u0432\u043d\u0443\u0442\u0440\u0435\u043d\u043d\u0438\u0445 \u0438 \u043d\u0430\u0440\u0443\u0436\u043d\u044b\u0445 \u0440\u0430\u0431\u043e\u0442') ||
        lowerText.includes('\u0444\u0430\u0441\u0430\u0434')
      ) {
        score += 12;
      } else {
        score -= 12;
      }
    }

    if (terms.includes('\u0433\u043b\u044f\u043d\u0446')) {
      if (title.includes('\u0433\u043b\u044f\u043d\u0446') || lowerText.includes('\u043f\u043e\u043b\u0443\u0433\u043b\u044f\u043d\u0446')) {
        score += 8;
      }
    }

    if (lowerText.includes('\u0446\u0435\u043d\u0430:')) score += 2;
    return score;
  }

  private mergeChunks(primary: Chunk[], secondary: Chunk[]): Chunk[] {
    const seen = new Set<string>();
    const merged: Chunk[] = [];

    for (const chunk of [...primary, ...secondary]) {
      const key = `${chunk.sourceFile}:${chunk.text.slice(0, 120)}`;
      if (seen.has(key)) continue;

      seen.add(key);
      merged.push(chunk);
    }

    return merged;
  }

  private splitIntoChunks(text: string, chunkSize: number): string[] {
    if (text.includes('\n---')) {
      return text.split(/\n---+\n?/).map(c => c.trim()).filter(c => c.length > 50);
    }

    const chunks: string[] = [];
    const overlap = 250;

    let i = 0;
    while (i < text.length) {
      const chunk = text.slice(i, i + chunkSize);
      chunks.push(chunk.trim());
      i += (chunkSize - overlap);
      if (i + overlap >= text.length) break;
    }
    return chunks.filter(c => c.length > 50);
  }
}
