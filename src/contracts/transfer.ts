import * as v from 'valibot';
import { nonNegativeInt, shortText } from './parse';
import { TRANSFER } from '../shared/config';

/**
 * File transfer, protocol 2.
 *
 * Control, JSON on `ctrl`:
 *   sender → receiver   file          metadata, sent just before the file's first block
 *   receiver → sender   file-ack      a block arrived, matched its SHA-256 and was stored
 *                       file-done     every block is in (ok), or one arrived damaged (not ok)
 *   either side         file-cancel
 *
 * Data, on any lane: a block header (JSON text), then exactly `n` bytes (binary). Every block carries
 * its own SHA-256, so blocks can travel over parallel lanes and arrive in any order.
 */

const FileId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,32}$/));
const BlockIndex = v.pipe(nonNegativeInt, v.maxValue(Math.ceil(TRANSFER.maxFileBytes / TRANSFER.minBlockBytes)));
const Sha256Hex = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

export const FileOfferSchema = v.object({
  t: v.literal('file'),
  f: FileId,
  name: shortText(TRANSFER.maxNameLength),
  size: v.pipe(nonNegativeInt, v.maxValue(TRANSFER.maxFileBytes)),
  mime: shortText(127),
  /** Block size this file is cut into. */
  block: v.pipe(nonNegativeInt, v.minValue(TRANSFER.minBlockBytes), v.maxValue(TRANSFER.maxBlockBytes)),
});
export type FileOffer = v.InferOutput<typeof FileOfferSchema>;

export const TransferControlSchema = v.variant('t', [
  FileOfferSchema,
  v.object({ t: v.literal('file-ack'), f: FileId, i: BlockIndex }),
  v.object({ t: v.literal('file-done'), f: FileId, ok: v.boolean() }),
  v.object({ t: v.literal('file-cancel'), f: FileId }),
]);
export type TransferControl = v.InferOutput<typeof TransferControlSchema>;

export const BlockHeaderSchema = v.object({
  t: v.literal('blk'),
  f: FileId,
  i: BlockIndex,
  n: v.pipe(nonNegativeInt, v.minValue(1), v.maxValue(TRANSFER.maxBlockBytes)),
  h: Sha256Hex,
});
export type BlockHeader = v.InferOutput<typeof BlockHeaderSchema>;
