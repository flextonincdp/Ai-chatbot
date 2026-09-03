const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const yaml = require('js-yaml');

// Helpers
function jsonToText(obj, prefix) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) return obj.map((item, i) => jsonToText(item, `${prefix}[${i}]`)).join('\n');
  if (typeof obj === 'object') {
    return Object.entries(obj).map(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      const val = jsonToText(v, key);
      return val.includes('\n') ? `${key}:\n${val}` : `${key}: ${val}`;
    }).join('\n');
  }
  return '';
}

const textExtensions = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm',
  'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sql', 'sh', 'ps1',
  'css', 'scss', 'env', 'log', 'ini', 'cfg', 'conf', 'properties', 'example'
]);

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif']);

/**
 * Pulls plain text out of an uploaded file so it can be chunked & indexed.
 * Returns { text, metadata }
 */
async function extractText(filePath, originalName, onProgress = null) {
  const extMatch = originalName.match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'txt';

  // 1. Text & Code files
  if (textExtensions.has(ext)) {
    let raw = fs.readFileSync(filePath, 'utf8');
    if (['html', 'htm', 'xml'].includes(ext)) {
      raw = raw.replace(/<script[\s\S]*?<\/script>/gi, '')
               .replace(/<style[\s\S]*?<\/style>/gi, '')
               .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    } else if (ext === 'json') {
      try { raw = jsonToText(JSON.parse(raw), ''); } catch { }
    } else if (ext === 'yaml' || ext === 'yml') {
      try { raw = jsonToText(yaml.load(raw), ''); } catch { }
    }
    return { text: `[File: ${originalName}]\n${raw}`, metadata: { unitLabel: 'document' } };
  }

  // 2. Spreadsheets (xlsx, xls, ods)
  if (['xlsx', 'xls', 'ods'].includes(ext)) {
    try {
      const workbook = XLSX.readFile(filePath);
      const sheetNames = workbook.SheetNames;
      const textParts = sheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        return `=== Sheet: ${name} ===\n${csv}`;
      });
      return { text: textParts.join('\n\n'), metadata: { sheetCount: sheetNames.length, unitLabel: 'sheets' } };
    } catch (e) {
      throw new Error(`Failed to read spreadsheet ${originalName}: ` + e.message);
    }
  }

  // 3. Images (OCR)
  if (imageExtensions.has(ext)) {
    const { performOcrOnImage } = require('./ocr');
    return await performOcrOnImage(filePath, { lang: process.env.OCR_LANG || 'eng' });
  }

  // 4. Archives (ZIP)
  if (ext === 'zip') {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    let combinedText = '';
    const tempDir = path.join(__dirname, '..', 'scratch', `zip_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      for (const entry of entries) {
        if (entry.isDirectory || entry.entryName.includes('__MACOSX') || entry.entryName.includes('.git/')) continue;
        const entryExt = entry.entryName.split('.').pop().toLowerCase();
        // Skip nested zips and dangerous binary files
        if (['zip', 'exe', 'dll', 'so', 'dylib', 'bin'].includes(entryExt)) continue;
        
        const tempPath = path.join(tempDir, path.basename(entry.entryName));
        fs.writeFileSync(tempPath, entry.getData());
        try {
          const res = await extractText(tempPath, entry.entryName);
          if (res.text.trim()) {
            combinedText += `\n\n--- [Archive File: ${entry.entryName}] ---\n${res.text}`;
          }
        } catch (e) {
           console.warn(`[ZIP] Failed to parse ${entry.entryName}:`, e.message);
        }
      }
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    return { text: combinedText.trim(), metadata: { unitLabel: 'archive' } };
  }

  // 5. Emails (EML, MSG)
  if (['eml', 'msg'].includes(ext)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    // Basic text extraction for MSG/EML headers & body
    let clean = raw.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, ' ') // strip binary chars if msg
                   .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (ext === 'eml') {
       const subject = (raw.match(/^Subject:\s*(.+)/mi) || [])[1] || '';
       const from    = (raw.match(/^From:\s*(.+)/mi) || [])[1] || '';
       const date    = (raw.match(/^Date:\s*(.+)/mi) || [])[1] || '';
       clean = `Subject: ${subject}\nFrom: ${from}\nDate: ${date}\n\n${clean}`;
    }
    return { text: clean, metadata: { unitLabel: 'email' } };
  }

  // 6. Word Docs (docx, doc, rtf, odt)
  if (['docx', 'doc', 'rtf', 'odt'].includes(ext)) {
    try {
      if (ext === 'docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        return { text: result.value, metadata: { unitLabel: 'pages' } };
      } else {
        // Fallback string extraction for older binary formats
        const raw = fs.readFileSync(filePath, 'utf8');
        const clean = raw.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
        return { text: clean, metadata: { unitLabel: 'document' } };
      }
    } catch (e) {
      throw new Error(`Failed to read document ${originalName}: ` + e.message);
    }
  }

  // 7. Presentations (pptx, ppt, odp)
  if (['pptx', 'ppt', 'odp'].includes(ext)) {
    if (ext === 'pptx') {
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
      let text = '';
      for (const entry of entries) {
        const xml = entry.getData().toString('utf8');
        const matches = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
        text += matches.join(' ') + '\n\n';
      }
      return { text, metadata: { slideCount: entries.length, unitLabel: 'slides' } };
    } else {
      const raw = fs.readFileSync(filePath, 'utf8');
      const clean = raw.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
      return { text: clean, metadata: { unitLabel: 'presentation' } };
    }
  }

  // 8. PDF
  if (ext === 'pdf') {
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    const nativeText = data.text || '';
    const cleaned = nativeText.replace(/\s+/g, '').trim();
    if (cleaned.length >= parseInt(process.env.OCR_MIN_TEXT_CHARS || '50', 10)) {
      return { text: nativeText, metadata: { pageCount: data.numpages, unitLabel: 'pages' } };
    }
    const { performOcrOnPdf } = require('./ocr');
    return await performOcrOnPdf(filePath, { maxPages: 500 }, onProgress);
  }

  // 9. SVG
  if (ext === 'svg') {
    const raw = fs.readFileSync(filePath, 'utf8');
    let safe = raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    const title = (safe.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const textMatches = [...safe.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/gi)].map(m => m[1])
       .concat([...safe.matchAll(/<text[^>]*>([^<]*)<\/text>/gi)].map(m => m[1].replace(/<[^>]*>/g,'').trim()));
    return { text: `Title: ${title}\n` + textMatches.filter(Boolean).join('\n'), metadata: { unitLabel: 'diagram' } };
  }

  throw new Error('Unsupported file type: .' + ext);
}

module.exports = { extractText };
