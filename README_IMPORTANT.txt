DeepProof - selected document-analysis files from Provenance

Included source files:
- analysis-pipeline.ts: orchestration for metadata checks, PDF structure, text/OCR extraction, and consistency checks.
- pdf-structure.ts: PDF structure/revision inspection.
- pdf-text-extractor.ts: text extraction from PDFs.
- pdf-rasterizer.ts: renders a PDF page for OCR fallback.
- image-metadata.ts: extracts image metadata.

IMPORTANT COMPATIBILITY NOTE
These are selected source files from Provenance, not a ready-to-drop-in DeepProof feature. analysis-pipeline.ts imports Provenance-specific database, file-storage, hash, and issuer-lookup modules and expects Provenance's upload flow. It will not work by uploading this folder alone; it needs adaptation to DeepProof's server/API.

Also, this source is forensic document analysis, NOT a trained AI-generated text/image detector. It checks metadata, PDF structure, extracts text/OCR, and flags consistency/tamper indicators. It cannot reliably conclude that content was AI-generated.

Use this package as a reference/extraction only. Do not overwrite existing DeepProof files with these files.
