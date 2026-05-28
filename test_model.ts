import { pipeline } from '@xenova/transformers';

async function test() {
    try {
        console.log('loading model...');
        const extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-mpnet-base-v2');
        const output = await extractor('привет мир', { pooling: 'mean', normalize: true });
        console.log('dims:', output.data.length);
    } catch (e) {
        console.error(e);
    }
}
test();
