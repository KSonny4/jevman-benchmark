import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIPS } from '../src/clips';
import { RECORDINGS } from '../src/recordings';

// Every game Watch plays has its highlight to save, rendered by `npm run clips` and listed in src/clips.ts.
describe('clips', () => {
  for (const model of Object.keys(RECORDINGS)) {
    it(`${model} has its highlight as MP4 and GIF`, () => {
      const clip = CLIPS[model];
      expect(clip, `no clip for ${model}: run npm run clips -- ${model}`).toBeDefined();
      for (const format of ['mp4', 'gif'] as const) {
        const file = new URL(`../public/clips/${clip!.file}.${format}`, import.meta.url);
        expect(existsSync(file), `public/clips/${clip!.file}.${format} is missing`).toBe(true);
        expect(statSync(file).size, `src/clips.ts lists another size: run npm run clips -- ${model}`).toBe(clip![format]);
      }
    });
  }
});
