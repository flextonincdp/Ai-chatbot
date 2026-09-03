const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createWorker } = require('tesseract.js');

const execFileAsync = promisify(execFile);

/**
 * Render a slice of PDF pages to PNG images using Python PyMuPDF backend.
 */
async function renderBatch(pdfPath, outDir, startPage, endPage, dpi = 150) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'render_pdf_pages.py');
  const pythonCmd = process.env.PYTHON_PATH || 'python';

  const { stdout, stderr } = await execFileAsync(pythonCmd, [
    scriptPath,
    '--pdf', pdfPath,
    '--outdir', outDir,
    '--start', String(startPage),
    '--end', String(endPage),
    '--dpi', String(dpi)
  ]);

  if (stderr && stderr.includes('Error')) {
    console.warn('[OCR] PDF renderer stderr:', stderr);
  }

  const result = JSON.parse(stdout.trim());
  if (!result.success) {
    throw new Error(result.error || 'Failed to render PDF pages');
  }

  return result;
}

/**
 * Perform OCR on a PDF document page-by-page in a memory-safe, batched manner.
 * 
 * @param {string} pdfPath - Path to the PDF file
 * @param {Object} options - Configuration options (lang, batchSize, maxPages, dpi)
 * @param {Function} onProgress - Optional callback for page progress updates
 * @returns {Promise<{text: string, metadata: Object}>}
 */
async function performOcrOnPdf(pdfPath, options = {}, onProgress = null) {
  const startTime = Date.now();
  const lang = options.lang || process.env.OCR_LANG || 'eng';
  const batchSize = parseInt(options.batchSize || process.env.OCR_PAGE_BATCH_SIZE || '5', 10);
  const maxPages = parseInt(options.maxPages || process.env.OCR_MAX_PAGES || '500', 10);
  const dpi = parseInt(options.dpi || '150', 10);

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found at ${pdfPath}`);
  }

  const tempBatchDir = path.join(__dirname, '..', 'scratch', `ocr_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tempBatchDir, { recursive: true });

  console.log(`[OCR] Starting PDF OCR for ${path.basename(pdfPath)}...`);

  // Probe total pages with page 1
  const firstPass = await renderBatch(pdfPath, tempBatchDir, 1, 1, dpi);
  const totalPagesDetected = firstPass.totalPages;
  const pagesToProcess = Math.min(totalPagesDetected, maxPages);

  if (pagesToProcess === 0) {
    try { fs.rmSync(tempBatchDir, { recursive: true, force: true }); } catch (e) {}
    throw new Error('PDF document contains 0 pages');
  }

  console.log(`[OCR] Detected ${totalPagesDetected} total pages. Processing ${pagesToProcess} page(s) in batches of ${batchSize}...`);

  let worker = null;
  const pageTexts = [];
  let ocrPagesProcessed = 0;

  try {
    worker = await createWorker(lang);

    for (let start = 1; start <= pagesToProcess; start += batchSize) {
      const end = Math.min(start + batchSize - 1, pagesToProcess);
      
      if (onProgress) {
        onProgress({
          currentPage: start,
          totalPages: pagesToProcess,
          status: `OCR_PROCESSING (Pages ${start}-${end}/${pagesToProcess})`
        });
      }

      // Render page batch
      const batchResult = await renderBatch(pdfPath, tempBatchDir, start, end, dpi);

      for (const pageInfo of batchResult.pages) {
        const pageNum = pageInfo.page;
        const imgPath = pageInfo.path;

        if (fs.existsSync(imgPath)) {
          const { data: { text } } = await worker.recognize(imgPath);
          
          const cleanPageText = (text || '').trim();
          if (cleanPageText) {
            pageTexts.push(`--- Page ${pageNum} ---\n${cleanPageText}`);
          } else {
            pageTexts.push(`--- Page ${pageNum} ---\n[No readable text detected on page ${pageNum}]`);
          }

          ocrPagesProcessed++;

          // Delete rendered image file immediately to free memory & disk space
          try { fs.unlinkSync(imgPath); } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.error('[OCR] OCR processing error:', err);
    throw new Error(`OCR processing error: ${err.message}`);
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch (e) {}
    }
    try { fs.rmSync(tempBatchDir, { recursive: true, force: true }); } catch (e) {}
  }

  const combinedText = pageTexts.join('\n\n');
  const durationMs = Date.now() - startTime;

  console.log(`[OCR] Completed OCR for ${ocrPagesProcessed}/${totalPagesDetected} page(s) in ${(durationMs / 1000).toFixed(1)}s.`);

  return {
    text: combinedText,
    metadata: {
      pageCount: totalPagesDetected,
      ocrPagesProcessed,
      extractionMethod: 'ocr',
      ocrStatus: 'SUCCESS',
      processingDurationMs: durationMs,
      unitLabel: 'pages'
    }
  };
}

/**
 * Perform OCR on a single image file.
 */
async function performOcrOnImage(imagePath, options = {}) {
  const lang = options.lang || process.env.OCR_LANG || 'eng';
  if (!fs.existsSync(imagePath)) throw new Error(`Image file not found at ${imagePath}`);
  
  console.log(`[OCR] Starting Image OCR for ${path.basename(imagePath)}...`);
  let worker = null;
  const startTime = Date.now();
  try {
    worker = await createWorker(lang);
    const { data: { text } } = await worker.recognize(imagePath);
    const durationMs = Date.now() - startTime;
    return {
      text: (text || '').trim(),
      metadata: { extractionMethod: 'ocr_image', processingDurationMs: durationMs, unitLabel: 'image' }
    };
  } finally {
    if (worker) try { await worker.terminate(); } catch (e) {}
  }
}

module.exports = {
  performOcrOnPdf,
  performOcrOnImage
};
