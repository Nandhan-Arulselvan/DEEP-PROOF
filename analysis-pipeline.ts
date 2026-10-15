import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import tesseract from "node-tesseract-ocr";
import { distance } from "fastest-levenshtein";
import { prisma } from "@provenance/db";
import {
  computeCanonicalContentHash,
  computePerceptualHash,
  hammingDistance,
  CredentialStructuredFields,
} from "./hash-utils.js";
import { ValidatedFile } from "./file-storage.js";
import { extractTextFromPdf } from "./pdf-text-extractor.js";
import { extractImageMetadata } from "./image-metadata.js";
import { analyzePdfStructure } from "./pdf-structure.js";
import { rasterizePdfFirstPage } from "./pdf-rasterizer.js";
import { runIssuerLookup } from "./issuer-connectors/index.js";

const KNOWN_EDITING_TOOLS = [
  "photoshop",
  "acrobat pro",
  "gimp",
  "illustrator",
  "canva",
  "inkscape",
  "coreldraw",
  "affinity",
  "pixelmator",
];

export function foldOcrCharacters(str: string): string {
  return str
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[OQ]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[S]/g, "5")
    .replace(/[B]/g, "8")
    .replace(/[Z]/g, "2")
    .replace(/[G]/g, "6");
}

export interface SignalItem {
  signalType: string;
  signalValue: {
    fact: string;
    disclaimer: string;
    // Provenance of the credential code used for an issuer lookup. Inlined as a union
    // rather than imported from issuer-connectors/types.ts to avoid a circular import.
    codeSource?: "candidate_entered" | "ocr_exact" | "ocr_reconstructed";
  };
  severity: "low_concern" | "review_recommended" | "inconclusive";
}

export interface PipelineResult {
  metadata: Record<string, any>;
  canonicalContentHash: string;
  phash: string | null;
  ocrText: string | null;
  ocrConfidence: number | null;
  analyses: SignalItem[];
  overallSeverity: "low_concern" | "review_recommended" | "inconclusive";
}

import { PDFDocument } from "pdf-lib";

/**
 * Extracts raw PDF metadata from buffer including /Producer, /Creator, /CreationDate, /ModDate.
 */
async function extractPdfMetadata(buffer: Buffer): Promise<{
  metadata: Record<string, any>;
  creationDate: Date | null;
  modDate: Date | null;
}> {
  const metadata: Record<string, any> = {};
  let creationDate: Date | null = null;
  let modDate: Date | null = null;

  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const prod = pdfDoc.getProducer();
    const creat = pdfDoc.getCreator();
    const title = pdfDoc.getTitle();
    const auth = pdfDoc.getAuthor();
    const subj = pdfDoc.getSubject();

    if (prod) metadata.Producer = prod;
    if (creat) metadata.Creator = creat;
    if (title) metadata.Title = title;
    if (auth) metadata.Author = auth;
    if (subj) metadata.Subject = subj;

    creationDate = pdfDoc.getCreationDate() || null;
    modDate = pdfDoc.getModificationDate() || null;

    if (creationDate) metadata.CreationDate = creationDate.toISOString();
    if (modDate) metadata.ModDate = modDate.toISOString();
  } catch (_err) {
    // Fallback regex parsing
    const textContent = buffer.toString("binary");
    const extractField = (key: string): string | null => {
      const regex = new RegExp(`/${key}\\s*\\(([^)]+)\\)`, "i");
      const match = textContent.match(regex);
      return match ? match[1] : null;
    };
    const prod = extractField("Producer");
    const creat = extractField("Creator");
    if (prod) metadata.Producer = prod;
    if (creat) metadata.Creator = creat;
  }

  return { metadata, creationDate, modDate };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Runs Tesseract OCR on image file path with TSV output to compute real mean confidence.
 */
async function runTesseractTsv(imagePath: string): Promise<{ text: string | null; confidence: number | null }> {
  try {
    const tsv = execSync(`tesseract "${imagePath}" stdout -l eng --psm 3 tsv 2>/dev/null`, {
      encoding: "utf8",
      timeout: 30000,
    });

    const lines = tsv.trim().split("\n");
    if (lines.length <= 1) return { text: null, confidence: null };

    const headers = lines[0].split("\t");
    const confIdx = headers.indexOf("conf");
    const textIdx = headers.indexOf("text");

    const confs: number[] = [];
    const words: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      const conf = parseFloat(cols[confIdx]);
      const text = cols[textIdx] ? cols[textIdx].trim() : "";
      if (!isNaN(conf) && conf > 0 && text) {
        confs.push(conf);
        words.push(text);
      }
    }

    const text = words.length > 0 ? words.join(" ") : null;
    const confidence = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length / 100 : null;

    return { text, confidence };
  } catch (_err) {
    // Fallback to basic tesseract wrapper if TSV execution fails
    try {
      const basicText = await tesseract.recognize(imagePath, { lang: "eng", oem: 1, psm: 3 });
      return { text: basicText.trim() || null, confidence: null };
    } catch (_basicErr) {
      return { text: null, confidence: null };
    }
  }
}

export interface PipelineParams {
  file: ValidatedFile;
  fileBuffer: Buffer;
  candidateName: string;
  candidateId?: string;
  documentId?: string;
  claimedIssuerName: string;
  credentialType: string;
  credentialTitle: string;
  issueDate?: Date | null;
  certificateNumber?: string | null;
  issuerId?: string | null;
}

/**
 * Executes the deterministic document self-upload analysis pipeline.
 */
export async function runDocumentAnalysisPipeline(params: PipelineParams): Promise<PipelineResult> {
  const {
    file,
    fileBuffer,
    candidateName,
    candidateId,
    documentId,
    claimedIssuerName,
    credentialType,
    credentialTitle,
    issueDate,
    certificateNumber,
    issuerId,
  } = params;

  const signals: SignalItem[] = [];
  let extractionFailed = false;

  // ==========================================
  // Stage 1: Metadata Extraction & Image Analysis
  // ==========================================
  let extractedMetadata: Record<string, any> = {};
  let creationDate: Date | null = null;
  let modDate: Date | null = null;

  if (file.mimeType === "application/pdf") {
    try {
      const pdfMeta = await extractPdfMetadata(fileBuffer);
      extractedMetadata = pdfMeta.metadata;
      creationDate = pdfMeta.creationDate;
      modDate = pdfMeta.modDate;
    } catch (e) {
      console.warn("PDF metadata extraction error:", e);
    }
  } else if (["image/png", "image/jpeg", "image/webp"].includes(file.mimeType)) {
    try {
      const imgMeta = await extractImageMetadata(fileBuffer, file.mimeType);
      extractedMetadata = imgMeta.metadata;
      creationDate = imgMeta.creationDate;
      modDate = imgMeta.modDate;
    } catch (e) {
      console.warn("Image metadata extraction error:", e);
    }
  }

  // Concatenate all tool and software fields
  const toolFields = [
    extractedMetadata.Producer,
    extractedMetadata.Creator,
    extractedMetadata.Software,
    extractedMetadata.CreatorTool,
    extractedMetadata.Source,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const detectedTool = KNOWN_EDITING_TOOLS.find((tool) => toolFields.includes(tool));

  if (detectedTool) {
    signals.push({
      signalType: "editing_software_detected",
      signalValue: {
        fact: `Metadata indicates document was created or modified using ${detectedTool.toUpperCase()}`,
        disclaimer:
          "Editing software is sometimes used for legitimate document preparation and does not by itself prove falsification.",
      },
      severity: "review_recommended",
    });
  }

  // Check ModDate vs CreationDate gap (> 24 hours)
  if (creationDate && modDate) {
    const diffHours = (modDate.getTime() - creationDate.getTime()) / (1000 * 60 * 60);
    if (diffHours > 24) {
      signals.push({
        signalType: "modification_time_gap",
        signalValue: {
          fact: `Document modification date is ${Math.round(diffHours)} hours after creation date`,
          disclaimer:
            "Time gaps between creation and modification can occur during standard administrative workflows or scans.",
        },
        severity: "review_recommended",
      });
    }
  }

  // Signal: metadata_absent (if no authoring tool/producer/creator metadata exists)
  const hasOriginMetadata = Boolean(
    extractedMetadata.Producer ||
      extractedMetadata.Creator ||
      extractedMetadata.Software ||
      extractedMetadata.CreatorTool ||
      extractedMetadata.Source ||
      extractedMetadata.Make ||
      extractedMetadata.Model
  );

  if (!hasOriginMetadata) {
    signals.push({
      signalType: "metadata_absent",
      signalValue: {
        fact: "No origin or authoring software metadata was recoverable from file headers",
        disclaimer:
          "Metadata is routinely stripped by messaging apps, screenshot tools, and privacy settings, and its absence does not indicate modification.",
      },
      severity: "low_concern",
    });
  }

  // ==========================================
  // Stage 2: PDF Structural Tamper Analysis
  // ==========================================
  if (file.mimeType === "application/pdf") {
    try {
      const pdfStruct = analyzePdfStructure(fileBuffer);
      if (pdfStruct.hasIncrementalUpdates) {
        signals.push({
          signalType: "pdf_incremental_update_detected",
          signalValue: {
            fact: `Document contains ${pdfStruct.revisionCount} revisions and was modified after its original save`,
            disclaimer:
              "Incremental updates are produced routinely by digital signing, annotation, and form-filling, and do not by themselves indicate that content was altered.",
          },
          severity: "review_recommended",
        });
      }
    } catch (e) {
      console.warn("PDF structural analysis error:", e);
    }
  }

  // ==========================================
  // Stage 3: Canonical Content Hash
  // ==========================================
  const structuredFields: CredentialStructuredFields = {
    candidateName,
    claimedIssuerName,
    credentialType,
    credentialTitle,
    issueDate,
    certificateNumber,
  };
  const canonicalContentHash = computeCanonicalContentHash(structuredFields);

  // ==========================================
  // Stage 4: Duplicate & Near-Duplicate Detection
  // ==========================================
  try {
    // 1. Exact byte duplicate detection
    const exactDuplicates = await prisma.document.findMany({
      where: {
        rawFileHash: file.rawFileHash,
        ...(documentId ? { id: { not: documentId } } : {}),
      },
      select: {
        id: true,
        candidateId: true,
      },
    });

    if (exactDuplicates.length > 0) {
      const hasDifferentCandidate = exactDuplicates.some((d) => d.candidateId !== candidateId);
      if (hasDifferentCandidate) {
        signals.push({
          signalType: "duplicate_file_different_candidate",
          signalValue: {
            fact: "A byte-identical file has been submitted by a different candidate account",
            disclaimer:
              "Shared or jointly issued documents and re-uploads after account changes can produce identical files.",
          },
          severity: "review_recommended",
        });
      } else {
        signals.push({
          signalType: "duplicate_file_same_candidate",
          signalValue: {
            fact: "This exact file was already submitted by this candidate account",
            disclaimer: "Re-uploading the same document is common and expected.",
          },
          severity: "low_concern",
        });
      }
    }
  } catch (e) {
    console.warn("Exact duplicate check error:", e);
  }

  // 2. Perceptual Hash + Near-Duplicate Comparison
  const phash = await computePerceptualHash(fileBuffer, file.mimeType);

  if (phash && phash !== "0000000000000000" && phash !== "ffffffffffffffff") {
    try {
      const otherDocs = await prisma.document.findMany({
        where: {
          phash: { not: null },
          ...(documentId ? { id: { not: documentId } } : {}),
        },
        select: {
          id: true,
          phash: true,
          candidateId: true,
          credentials: {
            select: { issuerId: true },
            take: 1,
          },
        },
      });

      let nearDuplicateFound = false;

      for (const otherDoc of otherDocs) {
        if (!otherDoc.phash || otherDoc.phash === "0000000000000000" || otherDoc.phash === "ffffffffffffffff") {
          continue;
        }

        const dist = hammingDistance(phash, otherDoc.phash);

        // Near-duplicate across different candidate accounts (distance <= 6)
        if (dist <= 6 && otherDoc.candidateId !== candidateId && !nearDuplicateFound) {
          signals.push({
            signalType: "near_duplicate_image_different_candidate",
            signalValue: {
              fact: "This document is visually near-identical to one submitted by a different candidate account",
              disclaimer:
                "Standard certificate templates and shared generation platforms produce visually similar documents across unrelated holders.",
            },
            severity: "review_recommended",
          });
          nearDuplicateFound = true;
        }

        // Cross-issuer template mismatch (distance <= 6 with different approved issuerId)
        if (dist <= 6 && issuerId) {
          const otherIssuerId = otherDoc.credentials[0]?.issuerId;
          if (otherIssuerId && otherIssuerId !== issuerId) {
            signals.push({
              signalType: "template_cross_issuer_mismatch",
              signalValue: {
                fact: "Document visual template closely matches a known template from a different issuing institution",
                disclaimer:
                  "Standard document layouts or shared certificate generation platforms across institutions can produce visual similarities.",
              },
              severity: "review_recommended",
            });
            break;
          }
        }
      }
    } catch (e) {
      console.warn("Near-duplicate comparison error:", e);
    }
  }

  // ==========================================
  // Stage 5: Text Extraction & OCR Confidence
  // ==========================================
  let extractedText: string | null = null;
  let ocrConfidence: number | null = null;
  let rasterizationFailed = false;

  if (file.mimeType === "application/pdf") {
    try {
      extractedText = extractTextFromPdf(file.filePath);
    } catch (e) {
      console.warn("PDF text extraction error:", e);
    }
  }

  // Fallback to Tesseract OCR if text is empty/minimal or if image file
  if (!extractedText || extractedText.trim().length < 10) {
    let ocrInputPath = file.filePath;
    let tempOcrPng: string | null = null;

    if (file.mimeType === "application/pdf") {
      try {
        const rasterBuffer = await rasterizePdfFirstPage(fileBuffer);
        tempOcrPng = path.join(
          os.tmpdir(),
          `ocr_rast_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.png`
        );
        fs.writeFileSync(tempOcrPng, rasterBuffer);
        ocrInputPath = tempOcrPng;
      } catch (rastErr) {
        console.warn("PDF rasterization failed during OCR fallback:", rastErr);
        rasterizationFailed = true;
        signals.push({
          signalType: "document_rendering_failed",
          signalValue: {
            fact: "The document could not be rendered for visual analysis",
            disclaimer:
              "Encrypted, malformed, or unusually structured PDFs can resist rendering without indicating anything about the document's content.",
          },
          severity: "inconclusive",
        });
      }
    }

    if (!rasterizationFailed) {
      try {
        const ocrRes = await runTesseractTsv(ocrInputPath);
        extractedText = ocrRes.text;
        ocrConfidence = ocrRes.confidence;
      } catch (e) {
        console.warn("OCR fallback error:", e);
        extractionFailed = true;
      } finally {
        if (tempOcrPng && fs.existsSync(tempOcrPng)) {
          try {
            fs.unlinkSync(tempOcrPng);
          } catch (_err) {}
        }
      }
    }
  }

  // ==========================================
  // Stage 6: Consistency Checks
  // ==========================================
  if (extractedText && extractedText.trim().length > 0) {
    const candidateLower = candidateName.toLowerCase().trim();

    // 1. Candidate Name Consistency Check (Word Boundary Regex)
    const nameWords = candidateLower.split(/\s+/).filter(Boolean);
    const containsAllWords = nameWords.every((word) => {
      const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
      return regex.test(extractedText!);
    });

    if (!containsAllWords) {
      // Compute best normalized similarity against candidate name
      const textWords = extractedText.toLowerCase().split(/\s+/).filter(Boolean);
      let bestSimilarity = 0;

      for (let i = 0; i <= textWords.length - nameWords.length; i++) {
        const slice = textWords.slice(i, i + nameWords.length).join(" ");
        const dist = distance(candidateLower, slice);
        const maxLen = Math.max(candidateLower.length, slice.length);
        const similarity = 1 - dist / maxLen;
        if (similarity > bestSimilarity) bestSimilarity = similarity;
      }

      if (bestSimilarity < 0.8) {
        signals.push({
          signalType: "candidate_name_mismatch",
          signalValue: {
            fact: `Extracted document text does not contain a close match for candidate name '${candidateName}'`,
            disclaimer:
              "Name formatting differences, maiden names, middle initials, or OCR text recognition errors can cause text mismatches.",
          },
          severity: "review_recommended",
        });
      }
    }

    // 2. Issue Year Consistency Check
    if (issueDate) {
      const declaredYear = new Date(issueDate).getFullYear().toString();
      const detectedYears = Array.from(new Set(extractedText.match(/\b(19\d\d|20\d\d)\b/g) || []));

      if (detectedYears.length > 0 && !detectedYears.includes(declaredYear)) {
        signals.push({
          signalType: "issue_year_mismatch",
          signalValue: {
            fact: `Declared issue year ${declaredYear} was not found in document text (detected years: ${detectedYears.join(
              ", "
            )})`,
            disclaimer:
              "Date formatting variations, graduation vs conferral dates, or OCR misreads may cause date detection mismatches.",
          },
          severity: "review_recommended",
        });
      }
    }

    // 3. Certificate Number Cross-Check (OCR character folding + 0.75 Levenshtein sliding window)
    if (certificateNumber && certificateNumber.trim()) {
      const normCert = certificateNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const normText = extractedText.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const foldedCert = foldOcrCharacters(certificateNumber);
      const foldedText = foldOcrCharacters(extractedText);

      if (normCert.length > 0 && normText.length > 0) {
        let certFound = false;

        // 1. Direct normalized match or folded match
        if (normText.includes(normCert) || foldedText.includes(foldedCert)) {
          certFound = true;
        } else if (normText.length >= normCert.length) {
          // 2. Sliding window on normalized and folded representations (threshold 0.75)
          const certLen = normCert.length;
          let bestSim = 0;

          for (let i = 0; i <= normText.length - certLen; i++) {
            const windowNorm = normText.substring(i, i + certLen);
            const distNorm = distance(normCert, windowNorm);
            const simNorm = 1 - distNorm / certLen;

            const windowFolded = foldedText.substring(i, i + certLen);
            const distFolded = distance(foldedCert, windowFolded);
            const simFolded = 1 - distFolded / certLen;

            const sim = Math.max(simNorm, simFolded);
            if (sim > bestSim) bestSim = sim;
            if (bestSim >= 0.75) break;
          }

          if (bestSim >= 0.75) {
            certFound = true;
          }
        }

        if (!certFound) {
          signals.push({
            signalType: "certificate_number_not_found",
            signalValue: {
              fact: `The certificate number entered ('${certificateNumber.trim()}') was not located in the document text`,
              disclaimer:
                "OCR misreads, certificate numbers printed in non-text graphical elements, and numbers appearing only on a reverse side can all prevent detection.",
            },
            severity: "review_recommended",
          });
        }
      }
    }
  } else {
    extractionFailed = true;
    signals.push({
      signalType: "text_extraction_unreadable",
      signalValue: {
        fact: "Automated text extraction could not recover legible text content from this document",
        disclaimer:
          "Low-resolution scans, non-standard fonts, or complex visual layouts can prevent automated text extraction.",
      },
      severity: "inconclusive",
    });
  }

  // ==========================================
  // Stage 7: Active Issuer Verification Lookup
  // ==========================================
  try {
    const lookupSignal = await runIssuerLookup({
      claimedIssuerName,
      certificateNumber,
      extractedText,
      candidateName,
      documentId,
    });
    if (lookupSignal) {
      signals.push(lookupSignal);
    }
  } catch (lookupErr) {
    console.warn("Issuer verification lookup caught error:", lookupErr);
    signals.push({
      signalType: "issuer_lookup_unavailable",
      signalValue: {
        fact: "Public verification lookup could not be completed at this time",
        disclaimer:
          "Network timeouts, third-party page layout updates, or rate limits can prevent public verification lookups from completing.",
      },
      severity: "inconclusive",
    });
  }

  // ==========================================
  // Stage 8: Overall Severity Computation
  // ==========================================
  let overallSeverity: "low_concern" | "review_recommended" | "inconclusive";
  const hasReviewRecommended = signals.some((s) => s.severity === "review_recommended");
  const hasInconclusive = signals.some((s) => s.severity === "inconclusive") || extractionFailed;

  if (hasReviewRecommended) {
    overallSeverity = "review_recommended";
  } else if (hasInconclusive) {
    overallSeverity = "inconclusive";
  } else {
    overallSeverity = "low_concern";
  }

  return {
    metadata: extractedMetadata,
    canonicalContentHash,
    phash,
    ocrText: extractedText,
    ocrConfidence,
    analyses: signals,
    overallSeverity,
  };
}
