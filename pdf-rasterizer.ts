import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

export function checkRasterizerAvailability(): { available: boolean; engine: "pdftoppm" | "sips" | "none" } {
  try {
    execSync("which pdftoppm", { stdio: "ignore" });
    return { available: true, engine: "pdftoppm" };
  } catch (_e1) {
    try {
      execSync("which sips", { stdio: "ignore" });
      return { available: true, engine: "sips" };
    } catch (_e2) {
      return { available: false, engine: "none" };
    }
  }
}

/**
 * Rasterizes page 1 of a PDF to a PNG Buffer.
 * Tries `pdftoppm` first (cross-platform poppler binary), then falls back to macOS `sips`.
 * Throws an Error if rasterization fails completely.
 */
export async function rasterizePdfFirstPage(pdfInput: Buffer | string): Promise<Buffer> {
  const uniqueId = `pdf_rast_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const tmpDir = os.tmpdir();
  let tempPdfPath: string | null = null;

  if (typeof pdfInput === "string") {
    tempPdfPath = pdfInput;
  } else {
    tempPdfPath = path.join(tmpDir, `${uniqueId}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfInput);
  }

  const ppmPrefix = path.join(tmpDir, `${uniqueId}_ppm`);
  const sipsOutPng = path.join(tmpDir, `${uniqueId}_sips.png`);
  const createdFiles: string[] = [];

  if (tempPdfPath !== pdfInput && tempPdfPath) {
    createdFiles.push(tempPdfPath);
  }

  try {
    // 1. Try pdftoppm (preferred, Linux/macOS standard)
    try {
      execSync(`pdftoppm -png -r 150 -f 1 -l 1 "${tempPdfPath}" "${ppmPrefix}" 2>/dev/null`, {
        timeout: 10000,
      });

      // Look for files generated with ppmPrefix
      const generated = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`${uniqueId}_ppm`));
      if (generated.length > 0) {
        const ppmFile = path.join(tmpDir, generated[0]);
        createdFiles.push(ppmFile);
        const pngBuf = fs.readFileSync(ppmFile);
        return pngBuf;
      }
    } catch (_ppmErr) {
      // Fallback to sips
    }

    // 2. Try macOS sips fallback
    try {
      execSync(`sips -s format png "${tempPdfPath}" --out "${sipsOutPng}" 2>/dev/null`, {
        timeout: 10000,
      });
      if (fs.existsSync(sipsOutPng)) {
        createdFiles.push(sipsOutPng);
        const pngBuf = fs.readFileSync(sipsOutPng);
        return pngBuf;
      }
    } catch (_sipsErr) {
      // Sips also failed
    }

    throw new Error("PDF rasterization failed: could not render page 1 with pdftoppm or sips");
  } finally {
    for (const f of createdFiles) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (_err) {}
      }
    }
  }
}
