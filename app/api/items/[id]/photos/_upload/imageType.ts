export type SniffedImageType = 'jpeg' | 'png' | 'webp';

export const EXT_FOR_TYPE: Record<SniffedImageType, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

// Magic-byte signatures: every listed offset must hold its byte. `minLength`
// is the shortest buffer that can hold the whole signature. WEBP is
// RIFF....WEBP: bytes 0-3 "RIFF", bytes 8-11 "WEBP" (bytes 4-7 are a size).
const SIGNATURES: Array<{
  type: SniffedImageType;
  minLength: number;
  bytes: Array<[offset: number, value: number]>;
}> = [
  { type: 'jpeg', minLength: 3, bytes: [[0, 0xff], [1, 0xd8], [2, 0xff]] },
  { type: 'png', minLength: 4, bytes: [[0, 0x89], [1, 0x50], [2, 0x4e], [3, 0x47]] },
  {
    type: 'webp',
    minLength: 12,
    bytes: [
      [0, 0x52], [1, 0x49], [2, 0x46], [3, 0x46],
      [8, 0x57], [9, 0x45], [10, 0x42], [11, 0x50],
    ],
  },
];

// Minimal magic-byte signature sniff — does not trust the declared
// Content-Type. JPEG: FF D8 FF. PNG: 89 50 4E 47. WEBP: RIFF....WEBP.
export function sniffImageType(bytes: Buffer): SniffedImageType | null {
  const match = SIGNATURES.find(
    (sig) => bytes.length >= sig.minLength && sig.bytes.every(([offset, value]) => bytes[offset] === value),
  );
  return match?.type ?? null;
}
