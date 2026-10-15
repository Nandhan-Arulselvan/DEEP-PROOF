import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Extracts raw text from a PDF file using an isolated Node process with pdf-parse.
 * This avoids TSX/ESM module loader polyfill collisions on typed arrays in Node 26.
 */
export function extractTextFromPdf(filePath: string): string | null {
  try {
    const inlineScript = `
const fs = require("fs");
const pdfParse = require("pdf-parse");
const file = process.argv[1];
const buf = fs.readFileSync(file);
pdfParse(buf).then(res => {
  process.stdout.write(res.text || "");
}).catch(err => {
  process.exit(1);
});
`;
    const result = execFileSync(process.execPath, ["-e", inlineScript, filePath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });
    return result || null;
  } catch (_err) {
    return null;
  }
}
