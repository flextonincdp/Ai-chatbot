const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const yaml = require('js-yaml');
const TurndownService = require('turndown');

const textExtensions = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sql', 'sh', 'ps1', 'css', 'scss', 'env', 'log', 'ini', 'cfg', 'conf', 'properties', 'example']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif']);

function decodeXml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function xmlText(xml) {
  return [...String(xml || '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map(match => decodeXml(match[1] || match[2] || '')).join('').replace(/\s+/g, ' ').trim();
}

function jsonToText(obj, prefix = '') {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) return obj.map((value, index) => jsonToText(value, `${prefix}[${index}]`)).join('\n');
  return Object.entries(obj).map(([key, value]) => {
    const label = prefix ? `${prefix}.${key}` : key;
    const content = jsonToText(value, label);
    return content.includes('\n') ? `${label}:\n${content}` : `${label}: ${content}`;
  }).join('\n');
}

/** Remove only deterministic extraction/rendering artifacts. */
function cleanStructuredText(text, { pageDelimited = false } = {}) {
  let clean = String(text || '')
    .replace(/!?(?:\[[^\]]*\])?\(data:[^)]+\)/gi, '')
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '')
    .replace(/[a-z0-9+/=]{160,}/gi, '')
    .replace(/\\\./g, '.')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(?:html|body|div|span|font)[^>]*>/gi, '')
    .replace(/\r\n?/g, '\n');
  const pages = pageDelimited ? clean.split(/\n(?=<!-- PAGE \d+ -->)/) : [clean];
  if (pages.length > 1) {
    const counts = new Map();
    for (const page of pages) for (const line of page.split('\n')) {
      const key = line.trim().replace(/\s+/g, ' ').toLowerCase();
      if (key && key.length < 120) counts.set(key, (counts.get(key) || 0) + 1);
    }
    clean = pages.map(page => page.split('\n').filter(line => {
      const normalized = line.trim().replace(/\s+/g, ' ').toLowerCase();
      if (/^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(normalized)) return false;
      if (/^knowledge studio\s+page\s+\d+(?:\s+of\s+\d+)?$/i.test(normalized)) return false;
      return !(normalized.length > 2 && normalized.length < 120 && counts.get(normalized) >= 2);
    }).join('\n')).join('\n');
  }
  const seenAdjacent = new Set();
  clean = clean.split('\n').filter(line => {
    const normalized = line.trim().replace(/\s+/g, ' ');
    if (!normalized) return true;
    if (seenAdjacent.has(normalized.toLowerCase())) return false;
    seenAdjacent.clear(); seenAdjacent.add(normalized.toLowerCase());
    return true;
  }).join('\n');
  return clean.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Some design-heavy PDFs store a rotated label one glyph at a time. Native
// extraction then produces dozens of lines such as "B\ne\ns\nt". That is not
// usable evidence for RAG and should trigger the OCR fallback instead.
function hasVerticalCharacterArtifacts(text) {
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  let run = 0;
  let longestRun = 0;
  let singleCharacterLines = 0;

  for (const line of lines) {
    if ([...line].length === 1 && /[\p{L}\p{N}&/.,:;()\-—]/u.test(line)) {
      run += 1;
      singleCharacterLines += 1;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }

  return longestRun >= 10 || (lines.length >= 20 && singleCharacterLines / lines.length > 0.3);
}

// Office files frequently use visual formatting rather than semantic heading
// styles. Promote only short standalone labels that introduce a list/table;
// this is deterministic and never invents source text.
function restoreImplicitHeadings(text) {
  const blocks = String(text || '').split(/\n\n+/).map(block => block.trim()).filter(Boolean);
  return blocks.map((block, index) => {
    const next = blocks[index + 1] || '';
    if (/^\d+\.\s+[A-Z]/.test(block) && /^(?:-|\*|•)\s+/.test(next)) return `## ${block}`;
    if (!/^[#|\-*•\d]/.test(block) && block.length <= 110 && !/[.!?]$/.test(block) && /^(?:\||-|\*|•|\d+\.\s+)/.test(next)) return `${index === 0 ? '#' : '##'} ${block}`;
    return block;
  }).join('\n\n');
}

function parseDocx(filePath) {
  const zip = new AdmZip(filePath);
  const documentXml = zip.readAsText('word/document.xml');
  if (!documentXml) throw new Error('DOCX document.xml is missing');
  const body = (documentXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/) || [])[1] || documentXml;
  const output = [];
  let listNumber = 0;
  for (const match of body.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    const block = match[0];
    if (block.startsWith('<w:tbl')) {
      const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(row => [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(cell => xmlText(cell[0])).filter(Boolean)).filter(row => row.length);
      if (rows.length) {
        const width = Math.max(...rows.map(row => row.length));
        output.push(rows.map((row, index) => {
          const cells = row.concat(Array(Math.max(0, width - row.length)).fill('')).map(value => value.replace(/\|/g, '\\|'));
          return `| ${cells.join(' | ')} |${index === 0 ? `\n| ${cells.map(() => '---').join(' | ')} |` : ''}`;
        }).join('\n'));
      }
      continue;
    }
    const value = xmlText(block); if (!value) continue;
    const style = ((block.match(/<w:pStyle[^>]*w:val="([^"]+)"/) || [])[1] || '').toLowerCase();
    const levelMatch = style.match(/heading\s*([1-6])|heading([1-6])/);
    if (levelMatch) { output.push(`${'#'.repeat(Number(levelMatch[1] || levelMatch[2]))} ${value}`); listNumber = 0; continue; }
    const level = Number(((block.match(/<w:ilvl[^>]*w:val="(\d+)"/) || [])[1]) || 0);
    if (/<w:numPr\b/.test(block)) {
      const indent = '  '.repeat(level); listNumber += level === 0 ? 1 : 0;
      output.push(`${indent}${style.includes('number') ? `${listNumber}.` : '-'} ${value}`);
    } else { listNumber = 0; output.push(value); }
  }
  return restoreImplicitHeadings(cleanStructuredText(output.join('\n\n')));
}

function parsePptx(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries().filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).sort((a, b) => Number(a.entryName.match(/\d+/)[0]) - Number(b.entryName.match(/\d+/)[0]));
  return cleanStructuredText(entries.map((entry, index) => {
    const paragraphs = [...entry.getData().toString('utf8').matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map(paragraph => ({ text: xmlText(paragraph[0]), level: Number(((paragraph[0].match(/<a:pPr[^>]*\blvl="(\d+)"/) || [])[1]) || 0) })).filter(item => item.text);
    if (!paragraphs.length) return '';
    const title = paragraphs.shift().text;
    return `<!-- SLIDE ${index + 1} -->\n\n# ${title}${paragraphs.length ? `\n\n${paragraphs.map(item => `${'  '.repeat(item.level)}- ${item.text}`).join('\n')}` : ''}`;
  }).filter(Boolean).join('\n\n'));
}

async function parsePdfByPage(buffer) {
  const pages = [];
  const data = await pdfParse(buffer, { pagerender: async page => {
    const content = await page.getTextContent({ normalizeWhitespace: false }); const lines = new Map();
    for (const item of content.items) { const y = Math.round((item.transform && item.transform[5]) || 0); if (!lines.has(y)) lines.set(y, []); lines.get(y).push({ x: (item.transform && item.transform[4]) || 0, text: item.str || '' }); }
    const text = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, values]) => values.sort((a, b) => a.x - b.x).map(value => value.text).join(' ').trim()).filter(Boolean).join('\n'); pages.push(text); return text;
  }});
  const text = cleanStructuredText(pages.map((page, index) => `<!-- PAGE ${index + 1} -->\n\n${page}`).join('\n\n'), { pageDelimited: true });
  return {
    text,
    pageCount: data.numpages || pages.length,
    hasVerticalCharacterArtifacts: hasVerticalCharacterArtifacts(text)
  };
}

async function extractText(filePath, originalName, onProgress = null) {
  const ext = (path.extname(originalName).slice(1) || 'txt').toLowerCase();
  if (textExtensions.has(ext)) {
    let raw = fs.readFileSync(filePath, 'utf8');
    if (['html', 'htm', 'xml'].includes(ext)) { raw = raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''); try { raw = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' }).turndown(raw); } catch { raw = raw.replace(/<[^>]+>/g, ' '); } }
    else if (ext === 'json') { try { raw = jsonToText(JSON.parse(raw)); } catch {} }
    else if (ext === 'yaml' || ext === 'yml') { try { raw = jsonToText(yaml.load(raw)); } catch {} }
    return { text: cleanStructuredText(`[File: ${originalName}]\n\n${raw}`), metadata: { unitLabel: 'document' } };
  }
  if (['xlsx', 'xls', 'ods'].includes(ext)) { const workbook = XLSX.readFile(filePath); return { text: cleanStructuredText(workbook.SheetNames.map(name => `# Sheet: ${name}\n\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false })}`).join('\n\n')), metadata: { sheetCount: workbook.SheetNames.length, unitLabel: 'sheets' } }; }
  if (imageExtensions.has(ext)) return require('./ocr').performOcrOnImage(filePath, { lang: process.env.OCR_LANG || 'eng' });
  if (ext === 'zip') {
    const zip = new AdmZip(filePath); const documents = [];
    for (const entry of zip.getEntries()) {
      const childExt = path.extname(entry.entryName).slice(1).toLowerCase();
      if (entry.isDirectory || /__MACOSX|\.git\//.test(entry.entryName) || !textExtensions.has(childExt)) continue;
      documents.push(`# Archive file: ${entry.entryName}\n\n${cleanStructuredText(entry.getData().toString('utf8'))}`);
    }
    return { text: cleanStructuredText(documents.join('\n\n')), metadata: { unitLabel: 'archive' } };
  }
  if (ext === 'docx') return { text: parseDocx(filePath), metadata: { unitLabel: 'document' } };
  if (['doc', 'rtf', 'odt'].includes(ext)) return { text: cleanStructuredText(fs.readFileSync(filePath, 'utf8')), metadata: { unitLabel: 'document' } };
  if (ext === 'pptx') { const text = parsePptx(filePath); return { text, metadata: { slideCount: (text.match(/<!-- SLIDE /g) || []).length, unitLabel: 'slides' } }; }
  if (['ppt', 'odp'].includes(ext)) return { text: cleanStructuredText(fs.readFileSync(filePath, 'utf8')), metadata: { unitLabel: 'presentation' } };
  if (ext === 'pdf') {
    const parsed = await parsePdfByPage(fs.readFileSync(filePath));
    const minimumTextChars = Number(process.env.OCR_MIN_TEXT_CHARS || 50);
    const usableNativeText = parsed.text.replace(/\s+/g, '').length >= minimumTextChars && !parsed.hasVerticalCharacterArtifacts;
    if (usableNativeText) {
      return {
        text: parsed.text,
        metadata: { pageCount: parsed.pageCount, unitLabel: 'pages', extractionMethod: 'native_pdf', ocrStatus: 'NOT_NEEDED' }
      };
    }

    if (String(process.env.OCR_ENABLED || 'true').toLowerCase() !== 'false') {
      try {
        return await require('./ocr').performOcrOnPdf(filePath, { maxPages: 500 }, onProgress);
      } catch (ocrError) {
        if (parsed.text.replace(/\s+/g, '').length >= minimumTextChars) {
          console.warn(`[PDF] OCR fallback failed; using native text with a quality warning: ${ocrError.message}`);
          return {
            text: parsed.text,
            metadata: { pageCount: parsed.pageCount, unitLabel: 'pages', extractionMethod: 'native_pdf', ocrStatus: 'FALLBACK_FAILED', qualityWarning: 'Rotated or fragmented PDF text detected.' }
          };
        }
        throw ocrError;
      }
    }

    return {
      text: parsed.text,
      metadata: { pageCount: parsed.pageCount, unitLabel: 'pages', extractionMethod: 'native_pdf', ocrStatus: 'DISABLED', qualityWarning: 'OCR is disabled.' }
    };
  }
  if (ext === 'svg') { const raw = fs.readFileSync(filePath, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, ''); const texts = [...raw.matchAll(/<(?:text|tspan)[^>]*>([\s\S]*?)<\/(?:text|tspan)>/gi)].map(match => match[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean); return { text: cleanStructuredText(texts.join('\n')), metadata: { unitLabel: 'diagram' } }; }
  throw new Error(`Unsupported file type: .${ext}`);
}

module.exports = { extractText, cleanStructuredText, hasVerticalCharacterArtifacts };
