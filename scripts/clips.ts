// Renders the highlight of every game Watch plays (src/recordings.ts), for people to download and share: the 18
// seconds in which the model scored the most as an MP4, and the best 10 seconds of those as a GIF, drawn by the game's
// own code in the arcade cabinet with the model's odds arrows. No model is called: it is a replay.
// Writes public/clips/<name>.mp4 and .gif (<name> as the recording's file, without -demo.json) and their sizes to
// src/clips.ts, which the page reads to offer them.
// Run: npm i --no-save @napi-rs/canvas && npm run clips [-- <model id> ...]
// Needs ffmpeg. On macOS the board's text and fruit use SF Mono and Apple Color Emoji, as Chrome draws them there.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { RECORDINGS, watchName } from '../src/recordings';
import { drawGame, FRUIT_EMOJI } from '../src/render';
import { Replay, type Recording } from '../src/replay';
import { fruitForLevel, type GameState } from '../src/sim';
import { Thinking } from '../src/thinking';

const W = 1080, H = 1402, FPS = 30, HIGHLIGHT_S = 18, GIF_S = 10;
const BOARD_W = 560, BOARD_H = 620;
const PIXEL = '"Press Start 2P"';
/** Where the reference clips have the maze's outer walls. */
const MAZE = { y0: 176, y1: 1224 };
const MANIFEST = 'src/clips.ts';
const OUT = 'public/clips';

type Canvas = any; // @napi-rs/canvas is installed for this script only (see Run above)
const canvasModule = '@napi-rs/canvas';
const { createCanvas, GlobalFonts } = (await import(canvasModule).catch(() => {
  console.error('This script needs @napi-rs/canvas: npm i --no-save @napi-rs/canvas');
  process.exit(1);
})) as { createCanvas: (w: number, h: number) => Canvas; GlobalFonts: { registerFromPath: (path: string, name: string) => void } };
GlobalFonts.registerFromPath('public/fonts/press-start-2p-latin.woff2', 'Press Start 2P');
for (const [path, name] of [['/System/Library/Fonts/SFNSMono.ttf', 'SF Mono'], ['/System/Library/Fonts/Apple Color Emoji.ttc', 'Apple Color Emoji']]) {
  if (existsSync(path)) GlobalFonts.registerFromPath(path, name);
}

/** The best single game any model played: the cabinet's HIGH SCORE in every clip. */
function topAiScore(): number {
  const board = JSON.parse(readFileSync('public/leaderboard.json', 'utf8')) as { entries: { bestScore?: number }[] };
  let best = Math.max(0, ...board.entries.map((e) => e.bestScore ?? 0));
  for (const id of existsSync('submissions') ? readdirSync('submissions') : []) {
    const dir = join('submissions', id);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((f) => /^game-\d+\.json\.gz$/.test(f))) {
      best = Math.max(best, (JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8')) as Recording).final.score);
    }
  }
  return best;
}

/** The game's board at its own size, with the browser's font names swapped for ones node-canvas has. */
const board = createCanvas(BOARD_W, BOARD_H);
const bctx = board.getContext('2d');
const fontDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(bctx), 'font')!;
Object.defineProperty(bctx, 'font', {
  get: () => fontDesc.get!.call(bctx),
  set: (v: string) => fontDesc.set!.call(bctx, v.replace('ui-monospace, monospace', '"SF Mono"').replace(/\bserif$/, '"Apple Color Emoji"')),
});
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

/** Scales the board into the card so its maze walls land where the reference clips have them, centred. */
function fitBoard(rec: Recording): { k: number; dx: number; dy: number } {
  drawGame(bctx, new Replay(rec).state, 0);
  const img = bctx.getImageData(0, 0, BOARD_W, BOARD_H).data as Uint8ClampedArray;
  let y0 = BOARD_H, y1 = 0;
  for (let y = 0; y < BOARD_H; y++) for (let x = 0; x < BOARD_W; x++) {
    const i = (y * BOARD_W + x) * 4;
    if (img[i + 2]! > 150 && img[i]! < 90 && img[i + 1]! < 90) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const k = (MAZE.y1 - MAZE.y0) / (y1 - y0);
  return { k, dx: (W - BOARD_W * k) / 2, dy: MAZE.y0 - y0 * k };
}

/** Pixel lettering, letter-spaced by hand. */
function text(s: string, x: number, y: number, size: number, color: string, align: 'left' | 'center' | 'right', spacing = 0): void {
  ctx.font = `${size}px ${PIXEL}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const chars = [...s];
  const adv = chars.map((c) => ctx.measureText(c).width + spacing);
  const total = adv.reduce((a, b) => a + b, 0) - spacing;
  let cx = align === 'left' ? x : align === 'center' ? x - total / 2 : x - total;
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += adv[i]!;
  });
}
function pac(cx: number, cy: number, r: number): void {
  ctx.fillStyle = '#ffd800';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, 0.55, Math.PI * 2 - 0.55);
  ctx.closePath();
  ctx.fill();
}

/** One frame: the cabinet (who plays and the score, HIGH SCORE, the ghosts), the board, then lives, the address, fruit. */
function drawCard(plate: string, high: string, fit: { k: number; dx: number; dy: number }, state: GameState, tSec: number, thinking: Thinking): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#2121de';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(10, 11, W - 20, H - 22, 22);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(21.5, 21.5, W - 43, H - 43, 13);
  ctx.stroke();
  // A long name shrinks to fit its third of the strip, where the page's ellipsis would cut it.
  const plateSize = Math.min(22, 330 / (plate.length * 1.04));
  text(plate, 44, 45 + (22 - plateSize) * 0.875, plateSize, '#ff3b3b', 'left', plateSize * 0.04);
  text(state.score.toLocaleString('en-US'), 46, 83, 35, '#ffffff', 'left', 0.7);
  text('HIGH SCORE', 538, 45, 22, '#ffffff', 'center', 0.9);
  text(high, 538, 83, 35, '#ffffff', 'center', 0.7);
  text('GHOSTS', 1032, 45, 22, '#8f97ff', 'right', 0.9);
  text('CLASSIC', 1032, 87, 23, '#ffffff', 'right', 0.5);
  drawGame(bctx, state, tSec);
  thinking.draw(bctx, tSec * 1000);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(board, fit.dx, fit.dy, BOARD_W * fit.k, BOARD_H * fit.k);
  for (let i = 0; i < Math.max(0, state.lives); i++) pac(61 + i * 43, 1322, 17);
  text('opper.ai/jevman-benchmark', 538, 1315, 18, '#ffd800', 'center', 0);
  ctx.font = '34px "Apple Color Emoji"';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const levels = Math.min(state.level, 7);
  ctx.fillText(Array.from({ length: levels }, (_, i) => FRUIT_EMOJI[fruitForLevel(state.level - levels + 1 + i).kind] ?? '').join(''), 1036, 1323);
}

/** The game at FPS frames a second of game time, then two seconds on GAME OVER. */
function* frames(rec: Recording): Generator<{ i: number; state: GameState; t: number; thinking: Thinking }> {
  const replay = new Replay(rec);
  const thinking = new Thinking();
  let pending = 0, t = 0, i = 0;
  while (!replay.done) {
    pending += 1 / FPS;
    t += 1 / FPS;
    while (!replay.done && pending >= rec.frames[replay.frame]!) {
      pending -= rec.frames[replay.frame]!;
      for (const e of replay.stepFrame()) if (e.type === 'decision') thinking.add(e.decision, t * 1000);
    }
    yield { i: i++, state: replay.state, t, thinking };
  }
  for (let h = 0; h < 2 * FPS; h++) {
    t += 1 / FPS;
    yield { i: i++, state: replay.state, t, thinking };
  }
}

/** The window of `n` frames from `from` (up to `to`) in which the score rose most: its first frame. */
function bestWindow(scores: number[], n: number, from = 0, to = scores.length): number {
  let best = -1, start = from;
  for (let s = from; s + n <= to; s++) {
    const gain = scores[s + n - 1]! - scores[s]!;
    if (gain > best) {
      best = gain;
      start = s;
    }
  }
  return start;
}

function ffmpeg(args: string[], input?: 'pipe') {
  return spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: [input ?? 'ignore', 'inherit', 'inherit'] });
}
const done = (p: ReturnType<typeof spawn>) => new Promise<void>((res, rej) => p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}`)))));

async function render(model: string, high: string): Promise<{ file: string; mp4: number; gif: number }> {
  const { path } = RECORDINGS[model]!;
  const file = path.replace(/^\/demo\//, '').replace(/-demo\.json$/, '');
  const rec = JSON.parse(readFileSync(join('public', path), 'utf8')) as Recording;
  const fit = fitBoard(rec);
  const plate = watchName(model).toUpperCase();
  const scores: number[] = [];
  for (const f of frames(rec)) scores.push(f.state.score);
  const n = HIGHLIGHT_S * FPS;
  const start = bestWindow(scores, Math.min(n, scores.length));
  const gifAt = bestWindow(scores, GIF_S * FPS, start, start + n) - start;
  const mp4 = join(OUT, `${file}.mp4`);
  const gif = join(OUT, `${file}.gif`);
  const enc = ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', mp4], 'pipe');
  const write = (buf: Buffer) => new Promise<void>((res) => (enc.stdin!.write(buf) ? res() : enc.stdin!.once('drain', () => res())));
  for (const f of frames(rec)) {
    if (f.i < start) continue;
    if (f.i >= start + n) break;
    drawCard(plate, high, fit, f.state, f.t, f.thinking);
    await write(Buffer.from((ctx.getImageData(0, 0, W, H).data as Uint8ClampedArray).buffer));
  }
  enc.stdin!.end();
  await done(enc);
  const palette = 'fps=20,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  await done(ffmpeg(['-ss', (gifAt / FPS).toFixed(2), '-t', String(GIF_S), '-i', mp4, '-vf', palette, '-loop', '0', gif]));
  console.log(`${model}: ${file}.mp4 from ${(start / FPS).toFixed(1)} s (+${scores[Math.min(start + n, scores.length) - 1]! - scores[start]!} points), ${file}.gif`);
  return { file, mp4: statSync(mp4).size, gif: statSync(gif).size };
}

const only = process.argv.slice(2).filter((a) => a !== '--');
for (const m of only) if (!RECORDINGS[m]) throw new Error(`${m} has no recording in src/recordings.ts`);
mkdirSync(OUT, { recursive: true });
const high = topAiScore().toLocaleString('en-US');
// A partial run keeps the other models' clips.
const manifest: Record<string, { file: string; mp4: number; gif: number }> = existsSync(MANIFEST) ? { ...(await import('../src/clips')).CLIPS } : {};
for (const model of Object.keys(RECORDINGS)) {
  if (only.length && !only.includes(model)) continue;
  manifest[model] = await render(model, high);
}
// In the recordings' order, for a tidy diff.
const ordered = Object.fromEntries(Object.keys(RECORDINGS).filter((m) => manifest[m]).map((m) => [m, manifest[m]]));
const header = '// Written by `npm run clips` (scripts/clips.ts): the highlight of each Watch recording in public/clips, and its sizes.\n';
writeFileSync(MANIFEST, `${header}export const CLIPS: Record<string, { file: string; mp4: number; gif: number }> = ${JSON.stringify(ordered, null, 2)};\n`);
console.log(`wrote ${Object.keys(ordered).length} clips to ${OUT}, HIGH SCORE ${high}`);
