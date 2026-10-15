import sharp from "sharp";
import exifReader from "exif-reader";
import zlib from "zlib";

/**
 * Parses PNG tEXt, zTXt, and iTXt chunks directly from PNG buffer.
 */
export function parsePngTextChunks(buffer: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  if (buffer.length < 8) return result;

  // Check PNG signature [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(pngSig)) return result;

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) break;

    const chunkData = buffer.subarray(dataStart, dataEnd);

    try {
      if (type === "tEXt") {
        const nullIdx = chunkData.indexOf(0x00);
        if (nullIdx > 0) {
          const keyword = chunkData.subarray(0, nullIdx).toString("latin1");
          const text = chunkData.subarray(nullIdx + 1).toString("latin1");
          result[keyword] = text;
        }
      } else if (type === "zTXt") {
        const nullIdx = chunkData.indexOf(0x00);
        if (nullIdx > 0 && chunkData.length > nullIdx + 2) {
          const keyword = chunkData.subarray(0, nullIdx).toString("latin1");
          // byte after null is compression method (0 = zlib deflate)
          const compressed = chunkData.subarray(nullIdx + 2);
          const decompressed = zlib.inflateSync(compressed).toString("utf8");
          result[keyword] = decompressed;
        }
      } else if (type === "iTXt") {
        const nullIdx = chunkData.indexOf(0x00);
        if (nullIdx > 0 && chunkData.length > nullIdx + 3) {
          const keyword = chunkData.subarray(0, nullIdx).toString("utf8");
          const compFlag = chunkData[nullIdx + 1];
          // skip comp method, lang tag, trans keyword
          let pos = nullIdx + 3;
          // find null after lang tag
          const nullLang = chunkData.indexOf(0x00, pos);
          if (nullLang > 0) pos = nullLang + 1;
          // find null after trans keyword
          const nullTrans = chunkData.indexOf(0x00, pos);
          if (nullTrans > 0) pos = nullTrans + 1;

          const textBytes = chunkData.subarray(pos);
          if (compFlag === 1) {
            const decompressed = zlib.inflateSync(textBytes).toString("utf8");
            result[keyword] = decompressed;
          } else {
            result[keyword] = textBytes.toString("utf8");
          }
        }
      }
    } catch (_err) {
      // Ignore individual corrupted chunk errors
    }

    if (type === "IEND") break;
    offset = dataEnd + 4; // skip CRC
  }

  return result;
}

function parseExifDate(d: any): Date | null {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d.getTime())) return d;
  if (typeof d === "string") {
    const m = d.match(/(\d{4})[:\-](\d{2})[:\-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return new Date(
        Date.UTC(
          parseInt(m[1], 10),
          parseInt(m[2], 10) - 1,
          parseInt(m[3], 10),
          parseInt(m[4], 10),
          parseInt(m[5], 10),
          parseInt(m[6], 10)
        )
      );
    }
    const p = new Date(d);
    return isNaN(p.getTime()) ? null : p;
  }
  return null;
}

export interface ImageMetadataResult {
  metadata: Record<string, any>;
  creationDate: Date | null;
  modDate: Date | null;
}

/**
 * Extracts metadata, EXIF properties, PNG chunks, and XMP toolkit strings from an image buffer.
 */
export async function extractImageMetadata(buffer: Buffer, mimeType: string): Promise<ImageMetadataResult> {
  const metadata: Record<string, any> = {};
  let creationDate: Date | null = null;
  let modDate: Date | null = null;

  try {
    const sharpMeta = await sharp(buffer).metadata();

    // 1. Parse EXIF buffer if present
    if (sharpMeta.exif) {
      try {
        const parsed = exifReader(sharpMeta.exif);

        if (parsed.Image) {
          if (parsed.Image.Software) metadata.Software = String(parsed.Image.Software);
          if (parsed.Image.Make) metadata.Make = String(parsed.Image.Make);
          if (parsed.Image.Model) metadata.Model = String(parsed.Image.Model);
          if (parsed.Image.DateTime) {
            modDate = parseExifDate(parsed.Image.DateTime);
            if (modDate) metadata.DateTime = modDate.toISOString();
          }
        }

        if (parsed.Photo) {
          if (parsed.Photo.DateTimeOriginal) {
            creationDate = parseExifDate(parsed.Photo.DateTimeOriginal);
            if (creationDate) metadata.DateTimeOriginal = creationDate.toISOString();
          }
          if (parsed.Photo.DateTimeDigitized && !creationDate) {
            creationDate = parseExifDate(parsed.Photo.DateTimeDigitized);
            if (creationDate) metadata.DateTimeDigitized = creationDate.toISOString();
          }
        }
      } catch (_exifErr) {
        // Corrupted or unsupported EXIF structure
      }
    }

    // 2. Parse XMP buffer if present
    if (sharpMeta.xmp) {
      try {
        const xmpStr = sharpMeta.xmp.toString("utf8");
        const creatorToolMatch = xmpStr.match(/<xmp:CreatorTool>(.*?)<\/xmp:CreatorTool>/i) ||
                                 xmpStr.match(/xmp:CreatorTool="([^"]+)"/i);
        if (creatorToolMatch && !metadata.CreatorTool && !metadata.Software) {
          metadata.CreatorTool = creatorToolMatch[1];
        }

        const createDateMatch = xmpStr.match(/<xmp:CreateDate>(.*?)<\/xmp:CreateDate>/i) ||
                                xmpStr.match(/xmp:CreateDate="([^"]+)"/i);
        if (createDateMatch && !creationDate) {
          creationDate = parseExifDate(createDateMatch[1]);
          if (creationDate) metadata.CreationDate = creationDate.toISOString();
        }

        const modifyDateMatch = xmpStr.match(/<xmp:ModifyDate>(.*?)<\/xmp:ModifyDate>/i) ||
                                xmpStr.match(/xmp:ModifyDate="([^"]+)"/i);
        if (modifyDateMatch && !modDate) {
          modDate = parseExifDate(modifyDateMatch[1]);
          if (modDate) metadata.ModDate = modDate.toISOString();
        }
      } catch (_xmpErr) {}
    }

    // 3. For PNG files, parse PNG text chunks directly
    if (mimeType === "image/png") {
      const pngChunks = parsePngTextChunks(buffer);
      for (const [key, val] of Object.entries(pngChunks)) {
        if (!val || typeof val !== "string" || !val.trim()) continue;
        const cleanVal = val.trim();
        const cleanKey = key.trim();

        if (/^Software$/i.test(cleanKey) && !metadata.Software) {
          metadata.Software = cleanVal;
        } else if (/^Creator$/i.test(cleanKey) && !metadata.Creator) {
          metadata.Creator = cleanVal;
        } else if (/^Source$/i.test(cleanKey) && !metadata.Source) {
          metadata.Source = cleanVal;
        } else if (/^Creation\s*Time$/i.test(cleanKey) && !creationDate) {
          creationDate = parseExifDate(cleanVal);
          if (creationDate) metadata.CreationTime = creationDate.toISOString();
          else metadata.CreationTime = cleanVal;
        } else if (cleanKey.length <= 32 && !metadata[cleanKey]) {
          metadata[cleanKey] = cleanVal.length > 200 ? cleanVal.substring(0, 200) + "..." : cleanVal;
        }
      }
    }
  } catch (err) {
    console.warn("Image metadata extraction failed:", err);
  }

  return { metadata, creationDate, modDate };
}
