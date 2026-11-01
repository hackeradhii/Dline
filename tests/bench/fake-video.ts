import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { seeded } from './random';

/**
 * The bench's camera, looped by Chrome's fake capture: a fixed textured picture with fresh, faint
 * noise in every frame, like a real camera's sensor noise. Measured on loopback, Chrome's VP8 then
 * sends 1280×720 at 30 fps and ~2.3–2.5 Mbit/s (its 720p ceiling) once ramped up. Pure noise does
 * not work: the encoder shrinks it to 320×180 at 0.6 Mbit/s. Generated into test-results/
 * (gitignored), never committed.
 */
export const FAKE_VIDEO = resolve('test-results/fake-camera-720p-textured.y4m');

const WIDTH = 1280;
const HEIGHT = 720;
const FRAMES = 10;
const LUMA = WIDTH * HEIGHT;
const FRAME_BYTES = LUMA * 1.5; // 4:2:0; chroma stays neutral grey.
/** Amplitude of the picture's fixed texture and of each frame's fresh noise (luma steps). */
const TEXTURE = 24;
const GRAIN = 8;
const HEADER = `YUV4MPEG2 W${WIDTH} H${HEIGHT} F30:1 Ip A1:1 C420jpeg\n`;
const FRAME_HEADER = 'FRAME\n';
const SIZE = HEADER.length + FRAMES * (FRAME_HEADER.length + FRAME_BYTES);

const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

/** Global setup: writes the camera clip unless it is already there (bench runs clear only test-results/bench). */
export default function writeFakeVideo(): void {
  if (existsSync(FAKE_VIDEO) && statSync(FAKE_VIDEO).size === SIZE) return;
  const random = seeded(720);
  const noise = (amplitude: number) => (random() * 2 - 1) * amplitude;
  const picture = Buffer.alloc(FRAME_BYTES, 128);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) picture[y * WIDTH + x] = byte(40 + ((x + y) * 160) / (WIDTH + HEIGHT) + noise(TEXTURE));
  }
  const parts = [Buffer.from(HEADER)];
  for (let f = 0; f < FRAMES; f++) {
    const frame = Buffer.from(picture);
    for (let i = 0; i < LUMA; i++) frame[i] = byte(frame[i]! + noise(GRAIN));
    parts.push(Buffer.from(FRAME_HEADER), frame);
  }
  mkdirSync(dirname(FAKE_VIDEO), { recursive: true });
  writeFileSync(FAKE_VIDEO, Buffer.concat(parts));
}
