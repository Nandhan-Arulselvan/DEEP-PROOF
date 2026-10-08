const crypto = require("crypto");

const MAX_PDF_BYTES = 25 * 1024 * 1024;

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Choose a non-empty PDF file.");
  if (buffer.length > MAX_PDF_BYTES) throw new Error("PDF exceeds the 25 MB limit.");
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("The submitted file is not a valid PDF byte stream.");
  }
}

module.exports = { MAX_PDF_BYTES, sha256Buffer, assertPdf };
