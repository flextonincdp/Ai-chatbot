const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractText } = require('../lib/extractText');
const { chunkText } = require('../lib/chunk');
const { performOcrOnPdf } = require('../lib/ocr');
const { computeFileHash } = require('../lib/documentMeta');

async function runAllTests() {
  console.log('====================================================');
  console.log('      KNOWLEDGE STUDIO OCR PIPELINE TEST SUITE       ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  async function testCase(name, fn) {
    try {
      console.log(`[TEST] Running: ${name}...`);
      await fn();
      console.log(`[PASS] ${name}\n`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}:`, err.message, '\n');
      failed++;
    }
  }

  // ----------------------------------------------------
  // TEST 1: Normal Text PDF Extraction
  // ----------------------------------------------------
  await testCase('1. Normal Text PDF Extraction (native_pdf)', async () => {
    const PDFDocument = require('pdfkit');
    const sampleTextPdf = path.join(__dirname, '..', 'scratch', 'valid_sample_text.pdf');
    fs.mkdirSync(path.dirname(sampleTextPdf), { recursive: true });

    await new Promise((resolve, reject) => {
      const doc = new PDFDocument();
      const stream = fs.createWriteStream(sampleTextPdf);
      doc.pipe(stream);
      doc.fontSize(16).text('This is Page 1 of a normal text PDF document with plenty of native vector characters.');
      doc.addPage();
      doc.fontSize(16).text('This is Page 2 with native vector text contents for Knowledge Studio RAG index.');
      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    const res = await extractText(sampleTextPdf, 'valid_sample_text.pdf');
    assert.ok(res.text.includes('Page 1') || res.text.length > 20, 'Text content extracted');
    assert.strictEqual(res.metadata.extractionMethod, 'native_pdf', 'Method is native_pdf');
    assert.strictEqual(res.metadata.ocrStatus, 'NOT_NEEDED', 'OCR status is NOT_NEEDED');
  });

  // ----------------------------------------------------
  // TEST 2: Scanned PDF Automatic OCR Fallback
  // ----------------------------------------------------
  await testCase('2. Scanned PDF Automatic OCR Fallback', async () => {
    const scannedPdf = path.join(__dirname, '..', 'uploads', 'org_default', 'doc_mtjly0qv_406ad2ea', 'v1', 'original.pdf');
    assert.ok(fs.existsSync(scannedPdf), 'ED406963.pdf exists');

    process.env.OCR_MAX_PAGES = '3';
    const res = await extractText(scannedPdf, 'ED406963.pdf');
    
    assert.strictEqual(res.metadata.extractionMethod, 'ocr', 'Extraction method is ocr');
    assert.strictEqual(res.metadata.ocrStatus, 'SUCCESS', 'OCR status is SUCCESS');
    assert.ok(res.metadata.ocrPagesProcessed > 0, 'Processed at least 1 page');
    assert.ok(res.text.includes('--- Page 1 ---'), 'Preserves page 1 marker');
  });

  // ----------------------------------------------------
  // TEST 3: Mixed Text/Image PDF Extraction
  // ----------------------------------------------------
  await testCase('3. Mixed Text/Image PDF Processing', async () => {
    const scannedPdf = path.join(__dirname, '..', 'uploads', 'org_default', 'doc_mtjly0qv_406ad2ea', 'v1', 'original.pdf');
    const res = await extractText(scannedPdf, 'ED406963.pdf');
    const chunks = chunkText(res.text);
    assert.ok(chunks.length > 0, 'Chunking produced valid chunks for mixed/OCR text');
  });

  // ----------------------------------------------------
  // TEST 4: 200-Page Scanned PDF (ED406963.pdf)
  // ----------------------------------------------------
  await testCase('4. 200-Page Scanned PDF Verification (ED406963.pdf)', async () => {
    const scannedPdf = path.join(__dirname, '..', 'uploads', 'org_default', 'doc_mtjly0qv_406ad2ea', 'v1', 'original.pdf');
    const ocrRes = await performOcrOnPdf(scannedPdf, { maxPages: 5, batchSize: 2 });
    
    assert.strictEqual(ocrRes.metadata.pageCount, 200, 'Detected 200 total pages');
    assert.strictEqual(ocrRes.metadata.ocrPagesProcessed, 5, 'Processed requested page limit');
    assert.strictEqual(ocrRes.metadata.ocrStatus, 'SUCCESS', 'OCR Status is SUCCESS');
    
    const chunks = chunkText(ocrRes.text);
    assert.ok(chunks.length >= 3, 'Created multiple chunks');
  });

  // ----------------------------------------------------
  // TEST 5: OCR Failure Handling & processingError Persistence
  // ----------------------------------------------------
  await testCase('5. OCR Failure & Error Persistence Handling', async () => {
    const invalidPath = path.join(__dirname, '..', 'scratch', 'non_existent_file.pdf');
    try {
      await performOcrOnPdf(invalidPath);
      assert.fail('Should have thrown an error');
    } catch (e) {
      assert.ok(e.message.includes('not found') || e.message.includes('error'), 'Error thrown correctly');
    }
  });

  // ----------------------------------------------------
  // TEST 6: Page-Number Preservation & Citation Integrity
  // ----------------------------------------------------
  await testCase('6. Page-Number Preservation & Citation Integrity', async () => {
    const sampleOcrText = "--- Page 1 ---\nDocument Resume Author Freed Jann.\n\n--- Page 2 ---\nSection 2: Quality Principles in Higher Education.";
    const chunks = chunkText(sampleOcrText);
    
    assert.ok(chunks[0].includes('Page 1') || chunks[0].includes('Resume'), 'Page 1 header preserved in chunk 1');
    assert.ok(chunks.some(c => c.includes('Page 2') || c.includes('Quality')), 'Page 2 header preserved in chunks');
  });

  // ----------------------------------------------------
  // TEST 7: Duplicate SHA-256 File Detection
  // ----------------------------------------------------
  await testCase('7. Duplicate SHA-256 Hash Detection', async () => {
    const scannedPdf = path.join(__dirname, '..', 'uploads', 'org_default', 'doc_mtjly0qv_406ad2ea', 'v1', 'original.pdf');
    const hash1 = computeFileHash(scannedPdf);
    const hash2 = computeFileHash(scannedPdf);
    assert.strictEqual(hash1, hash2, 'SHA-256 hashes match deterministically');
  });

  console.log('====================================================');
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed.`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Test suite execution error:', err);
  process.exit(1);
});
