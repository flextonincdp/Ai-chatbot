// End-to-end test for artifact storage, persistence, and download.
// Tests the full lifecycle: generate → persist → download → validate → restart → download again.
// 
// Usage: node scripts/test_artifact_lifecycle.js
// Requires the server to be running at localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
let sessionCookie = null;
let conversationId = null;

const results = {};

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {}
    };

    if (sessionCookie) {
      options.headers['Cookie'] = sessionCookie;
    }

    if (body) {
      const data = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        // Capture set-cookie
        if (res.headers['set-cookie']) {
          sessionCookie = res.headers['set-cookie']
            .map(c => c.split(';')[0])
            .join('; ');
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: rawBody,
          text: rawBody.toString('utf8')
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login() {
  console.log('\n=== Step 1: Login ===');
  const res = await request('POST', '/api/login', {
    role: 'admin',
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'password@123'
  });
  
  if (res.status !== 200) {
    // Try user access code
    const res2 = await request('POST', '/api/login', {
      role: 'user',
      code: process.env.USER_ACCESS_CODE || 'user123'
    });
    if (res2.status !== 200) {
      console.error('Login failed:', res2.text);
      process.exit(1);
    }
  }
  console.log('Login successful. Cookie:', sessionCookie ? 'SET' : 'MISSING');
}

async function testSvgArtifact() {
  console.log('\n=== Step 2: Generate SVG Diagram ===');
  const res = await request('POST', '/api/chat/ask', {
    query: 'Create a professional flow diagram from the uploaded documents.',
    conversationId
  });

  if (res.status !== 200) {
    console.error('Chat ask failed:', res.status, res.text.slice(0, 500));
    results.SVG = { generated: 'FAIL', reason: 'Chat ask returned ' + res.status };
    return null;
  }

  let data;
  try { data = JSON.parse(res.text); } catch { 
    results.SVG = { generated: 'FAIL', reason: 'Non-JSON response' };
    return null;
  }

  conversationId = data.conversationId;

  if (!data.diagram || !data.diagram.downloadUrl) {
    console.log('No diagram generated (LLM may not have produced one). Intent:', JSON.stringify(data.intent));
    results.SVG = { generated: 'SKIP', reason: 'LLM did not produce diagram intent' };
    return null;
  }

  console.log('SVG diagram generated. Download URL:', data.diagram.downloadUrl);
  console.log('SVG preview length:', data.diagram.svg ? data.diagram.svg.length : 0);
  
  // Validate preview
  const svgPreview = data.diagram.svg || '';
  const previewValid = svgPreview.includes('<svg') && svgPreview.includes('</svg>');
  console.log('SVG preview valid:', previewValid);

  return data.diagram;
}

async function testDocumentArtifact(format, query) {
  console.log(`\n=== Generate ${format.toUpperCase()} Document ===`);
  const res = await request('POST', '/api/chat/ask', {
    query,
    conversationId
  });

  if (res.status !== 200) {
    console.error('Chat ask failed:', res.status, res.text.slice(0, 500));
    results[format.toUpperCase()] = { generated: 'FAIL', reason: 'Chat ask returned ' + res.status };
    return null;
  }

  let data;
  try { data = JSON.parse(res.text); } catch {
    results[format.toUpperCase()] = { generated: 'FAIL', reason: 'Non-JSON response' };
    return null;
  }

  conversationId = data.conversationId;

  if (!data.document || !data.document.downloadUrl) {
    console.log(`No ${format} document generated. Intent:`, JSON.stringify(data.intent));
    results[format.toUpperCase()] = { generated: 'SKIP', reason: 'LLM did not produce document intent' };
    return null;
  }

  console.log(`${format.toUpperCase()} generated. Download URL:`, data.document.downloadUrl);
  return data.document;
}

async function testDownload(label, downloadUrl) {
  console.log(`\n--- Downloading ${label} from ${downloadUrl} ---`);
  const res = await request('GET', downloadUrl);

  const entry = {
    generated: 'PASS',
    persisted: res.status === 200 ? 'PASS' : 'FAIL',
    downloadHTTP: res.status,
    correctMIME: res.headers['content-type'] || 'MISSING',
    size: res.body.length,
    validFile: 'UNKNOWN',
    opens: 'MANUAL',
    survivesRestart: 'PENDING'
  };

  if (res.status !== 200) {
    console.error(`Download failed: HTTP ${res.status}`, res.text.slice(0, 200));
    entry.validFile = 'FAIL';
    results[label] = entry;
    return { entry, downloadUrl };
  }

  console.log(`  HTTP: ${res.status}`);
  console.log(`  Content-Type: ${res.headers['content-type']}`);
  console.log(`  Content-Length header: ${res.headers['content-length'] || 'MISSING'}`);
  console.log(`  Content-Disposition: ${res.headers['content-disposition'] || 'MISSING'}`);
  console.log(`  Body size: ${res.body.length} bytes`);

  // Format-specific validation
  const fmt = label.toLowerCase();
  if (fmt === 'svg') {
    const text = res.body.toString('utf8');
    const startValid = text.trimStart().startsWith('<svg') || text.includes('<svg');
    const endValid = text.includes('</svg>');
    entry.validFile = (startValid && endValid) ? 'PASS' : 'FAIL';
    entry.correctExtension = downloadUrl.includes('.svg') || (res.headers['content-disposition'] || '').includes('.svg') ? 'PASS' : 'FAIL';
    console.log(`  Starts with <svg: ${startValid}`);
    console.log(`  Ends with </svg>: ${endValid}`);
    
    const outPath = path.join(__dirname, '..', 'test_output_artifact.svg');
    fs.writeFileSync(outPath, res.body);
    console.log(`  Saved to: ${outPath}`);
  } else if (fmt === 'pdf') {
    const sig = res.body.toString('utf8', 0, 5);
    entry.validFile = sig === '%PDF-' ? 'PASS' : 'FAIL';
    entry.correctExtension = (res.headers['content-disposition'] || '').includes('.pdf') ? 'PASS' : 'FAIL';
    console.log(`  PDF signature: ${sig} (valid: ${sig === '%PDF-'})`);
    
    const outPath = path.join(__dirname, '..', 'test_output_artifact.pdf');
    fs.writeFileSync(outPath, res.body);
    console.log(`  Saved to: ${outPath}`);
  } else if (fmt === 'docx') {
    const sig = res.body.toString('utf8', 0, 2);
    entry.validFile = sig === 'PK' ? 'PASS' : 'FAIL';
    entry.correctExtension = (res.headers['content-disposition'] || '').includes('.docx') ? 'PASS' : 'FAIL';
    console.log(`  OOXML ZIP signature: ${sig} (valid: ${sig === 'PK'})`);
    
    const outPath = path.join(__dirname, '..', 'test_output_artifact.docx');
    fs.writeFileSync(outPath, res.body);
    console.log(`  Saved to: ${outPath}`);
  } else if (fmt === 'pptx') {
    const sig = res.body.toString('utf8', 0, 2);
    entry.validFile = sig === 'PK' ? 'PASS' : 'FAIL';
    entry.correctExtension = (res.headers['content-disposition'] || '').includes('.pptx') ? 'PASS' : 'FAIL';
    console.log(`  OOXML ZIP signature: ${sig} (valid: ${sig === 'PK'})`);
    
    const outPath = path.join(__dirname, '..', 'test_output_artifact.pptx');
    fs.writeFileSync(outPath, res.body);
    console.log(`  Saved to: ${outPath}`);
  }

  results[label] = entry;
  return { entry, downloadUrl };
}

async function testRepeatedDownload(label, downloadUrl) {
  console.log(`\n--- Repeated download test for ${label} ---`);
  for (let i = 1; i <= 3; i++) {
    const res = await request('GET', downloadUrl);
    const ok = res.status === 200 && res.body.length > 0;
    console.log(`  Attempt ${i}: HTTP ${res.status}, size ${res.body.length} -> ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
      results[label].survivesRestart = 'FAIL';
      return false;
    }
  }
  return true;
}

function printTable() {
  console.log('\n\n========================================');
  console.log('         ACCEPTANCE TABLE');
  console.log('========================================\n');

  const header = '| Format | Generated | Persisted | Download HTTP | Correct MIME | Size | Valid File | Opens | Survives Restart |';
  const sep =    '|--------|-----------|-----------|---------------|--------------|------|-----------|-------|------------------|';
  console.log(header);
  console.log(sep);

  for (const [fmt, r] of Object.entries(results)) {
    const row = `| ${fmt} | ${r.generated || '-'} | ${r.persisted || '-'} | ${r.downloadHTTP || '-'} | ${r.correctMIME || '-'} | ${r.size || '-'} | ${r.validFile || '-'} | ${r.opens || '-'} | ${r.survivesRestart || '-'} |`;
    console.log(row);
  }

  console.log('\n');
}

async function main() {
  try {
    await login();

    // Test SVG
    const svgDiagram = await testSvgArtifact();
    if (svgDiagram) {
      const svgResult = await testDownload('SVG', svgDiagram.downloadUrl);
      if (svgResult && svgResult.entry.persisted === 'PASS') {
        await testRepeatedDownload('SVG', svgDiagram.downloadUrl);
      }
    }

    // Test PDF
    const pdfDoc = await testDocumentArtifact('pdf', 'Create a professional PDF report from the uploaded documents.');
    if (pdfDoc) {
      const pdfResult = await testDownload('PDF', pdfDoc.downloadUrl);
      if (pdfResult && pdfResult.entry.persisted === 'PASS') {
        await testRepeatedDownload('PDF', pdfDoc.downloadUrl);
      }
    }

    // Test DOCX
    const docxDoc = await testDocumentArtifact('docx', 'Create a professional DOCX report from the uploaded documents.');
    if (docxDoc) {
      const docxResult = await testDownload('DOCX', docxDoc.downloadUrl);
      if (docxResult && docxResult.entry.persisted === 'PASS') {
        await testRepeatedDownload('DOCX', docxDoc.downloadUrl);
      }
    }

    // Test PPTX
    const pptxDoc = await testDocumentArtifact('pptx', 'Create a professional PowerPoint presentation from the uploaded documents.');
    if (pptxDoc) {
      const pptxResult = await testDownload('PPTX', pptxDoc.downloadUrl);
      if (pptxResult && pptxResult.entry.persisted === 'PASS') {
        await testRepeatedDownload('PPTX', pptxDoc.downloadUrl);
      }
    }

    printTable();

    // Print download URLs for post-restart test
    console.log('=== DOWNLOAD URLS FOR POST-RESTART TEST ===');
    if (svgDiagram) console.log('SVG:', svgDiagram.downloadUrl);
    if (pdfDoc) console.log('PDF:', pdfDoc.downloadUrl);
    if (docxDoc) console.log('DOCX:', docxDoc.downloadUrl);
    if (pptxDoc) console.log('PPTX:', pptxDoc.downloadUrl);

  } catch (err) {
    console.error('Test failed:', err);
  }
}

main();
