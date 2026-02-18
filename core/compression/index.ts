export const COMPRESSION_ALGORITHM = {
  GZIP: 'gzip',
  NONE: 'none',
  SNAPPY: 'snappy', // Requires external dependency
} as const;

export type CompressionAlgorithm = typeof COMPRESSION_ALGORITHM[keyof typeof COMPRESSION_ALGORITHM];
