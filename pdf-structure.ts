export interface PdfStructureAnalysis {
  eofCount: number;
  hasPrevTrailer: boolean;
  hasNonZeroGeneration: boolean;
  hasIncrementalUpdates: boolean;
  revisionCount: number;
}

/**
 * Performs byte-level structural tamper analysis on PDF buffer without rendering.
 * Detects %%EOF occurrences, /Prev trailer pointers, and nonzero generation objects.
 */
export function analyzePdfStructure(buffer: Buffer): PdfStructureAnalysis {
  const binaryContent = buffer.toString("binary");

  // 1. Count %%EOF markers
  const eofMatches = binaryContent.match(/%%EOF/g) || [];
  const eofCount = eofMatches.length;

  // 2. Check for /Prev in trailer dictionaries
  const prevMatches = binaryContent.match(/\/Prev\s+\d+/g) || [];
  const hasPrevTrailer = prevMatches.length > 0;

  // 3. Check for object generation numbers > 0 (e.g. "12 1 obj")
  const generationMatches = binaryContent.match(/\b\d+\s+[1-9]\d*\s+obj\b/g) || [];
  const hasNonZeroGeneration = generationMatches.length > 0;

  // A document with multiple %%EOF markers or /Prev in trailer has incremental updates
  const hasIncrementalUpdates = eofCount > 1 || hasPrevTrailer;
  const revisionCount = Math.max(eofCount, hasPrevTrailer ? 2 : 1);

  return {
    eofCount,
    hasPrevTrailer,
    hasNonZeroGeneration,
    hasIncrementalUpdates,
    revisionCount,
  };
}
