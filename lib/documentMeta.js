const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────
// Single source of truth for supported knowledge-document formats.
// The admin UI and upload validation both read from this list.
// ────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [
  // Documents
  'pdf', 'docx', 'doc', 'txt', 'md', 'markdown', 'rtf', 'odt',
  // Spreadsheets & Data
  'csv', 'tsv', 'xlsx', 'xls', 'ods', 'json', 'yaml', 'yml',
  // Presentations
  'pptx', 'ppt', 'odp',
  // Web & Markup
  'html', 'htm', 'xml',
  // Images/Diagrams
  'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'bmp',
  // Archives
  'zip',
  // Email
  'eml', 'msg',
  // Code & Technical
  'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb',
  'sql', 'sh', 'ps1', 'css', 'scss',
  // Config & Log
  'log', 'ini', 'cfg', 'conf', 'properties', 'env', 'example'
];

const MIME_MAP = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword',
  txt:  'text/plain',
  md:   'text/markdown',
  markdown: 'text/markdown',
  rtf:  'application/rtf',
  odt:  'application/vnd.oasis.opendocument.text',
  csv:  'text/csv',
  tsv:  'text/tab-separated-values',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
  ods:  'application/vnd.oasis.opendocument.spreadsheet',
  json: 'application/json',
  yaml: 'text/yaml',
  yml:  'text/yaml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt:  'application/vnd.ms-powerpoint',
  odp:  'application/vnd.oasis.opendocument.presentation',
  html: 'text/html',
  htm:  'text/html',
  xml:  'application/xml',
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
  tiff: 'image/tiff',
  bmp:  'image/bmp',
  zip:  'application/zip',
  eml:  'message/rfc822',
  msg:  'application/vnd.ms-outlook',
  py:   'text/x-python',
  js:   'text/javascript',
  jsx:  'text/javascript',
  ts:   'text/typescript',
  tsx:  'text/typescript',
  java: 'text/x-java-source',
  c:    'text/x-c',
  cpp:  'text/x-c++src',
  cs:   'text/x-csharp',
  go:   'text/x-go',
  rs:   'text/x-rustsrc',
  php:  'text/x-php',
  rb:   'text/x-ruby',
  sql:  'text/x-sql',
  sh:   'text/x-shellscript',
  ps1:  'text/plain',
  css:  'text/css',
  scss: 'text/x-scss',
  log:  'text/plain',
  ini:  'text/plain',
  cfg:  'text/plain',
  conf: 'text/plain',
  properties: 'text/plain',
  env:  'text/plain',
  example: 'text/plain'
};

// Allowed MIME types per extension (browsers sometimes send different ones)
// Only list types that have strict or varying browser behavior.
// Everything else falls through to 'application/octet-stream' which is always allowed.
const ALLOWED_MIMES = {};
for (const ext of SUPPORTED_EXTENSIONS) {
  ALLOWED_MIMES[ext] = [MIME_MAP[ext], 'application/octet-stream', 'text/plain'].filter(Boolean);
}
// Add extra common MIME overrides browsers might send
ALLOWED_MIMES.docx.push('application/zip');
ALLOWED_MIMES.xlsx.push('application/zip');
ALLOWED_MIMES.pptx.push('application/zip');
ALLOWED_MIMES.csv.push('application/vnd.ms-excel');
ALLOWED_MIMES.md.push('text/x-markdown');
ALLOWED_MIMES.svg.push('text/xml', 'application/xml');

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_PER_UPLOAD = 100;

// ────────────────────────────────────────────────────────────
// Document ID generation
// ────────────────────────────────────────────────────────────

function generateDocumentId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `doc_${ts}_${rand}`;
}

// ────────────────────────────────────────────────────────────
// SHA-256 hash of file content
// ────────────────────────────────────────────────────────────

function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ────────────────────────────────────────────────────────────
// Filename sanitization — strip path traversal, control chars
// ────────────────────────────────────────────────────────────

function sanitizeFilename(raw) {
  // Take only the basename (strip any path segments)
  let name = path.basename(raw);
  // Remove control characters and null bytes
  name = name.replace(/[\x00-\x1f\x7f]/g, '');
  // Remove path traversal patterns
  name = name.replace(/\.\./g, '');
  // Collapse whitespace
  name = name.replace(/\s+/g, ' ').trim();
  return name || 'unnamed_file';
}

// ────────────────────────────────────────────────────────────
// Determine the unit label for a file type
// ────────────────────────────────────────────────────────────

function getUnitLabel(ext) {
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'slides';
  if (ext === 'pdf') return 'pages';
  if (['docx', 'doc', 'odt'].includes(ext)) return 'pages';
  if (['xlsx', 'xls', 'ods'].includes(ext)) return 'sheets';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'bmp'].includes(ext)) return 'image';
  if (ext === 'zip') return 'archive';
  if (['eml', 'msg'].includes(ext)) return 'email';
  return 'document';
}

// ────────────────────────────────────────────────────────────
// Build a canonical document metadata object
// ────────────────────────────────────────────────────────────

function buildDocumentMeta({ file, extractionMeta, chunkCount, documentId }) {
  const ext = sanitizeFilename(file.originalname).split('.').pop().toLowerCase();
  const id = documentId || generateDocumentId();

  return {
    id,
    documentId: id,
    originalFilename: sanitizeFilename(file.originalname),
    name: sanitizeFilename(file.originalname),
    extension: ext,
    type: ext,
    mimeType: MIME_MAP[ext] || file.mimetype || 'application/octet-stream',
    size: file.size || 0,
    hash: null,                           // set by caller after hashing
    pageCount: (extractionMeta && extractionMeta.pageCount) || null,
    slideCount: (extractionMeta && extractionMeta.slideCount) || null,
    unitLabel: (extractionMeta && extractionMeta.unitLabel) || getUnitLabel(ext),
    chunkCount: chunkCount || 0,
    status: 'ready',
    processingStatus: 'completed',
    indexingStatus: 'completed',
    uploadedAt: Date.now(),
    processedAt: Date.now(),
    uploadedBy: null,                     // set by caller from session
    processingError: null
  };
}

// ────────────────────────────────────────────────────────────
// Validate a file before processing
// ────────────────────────────────────────────────────────────

function validateFile(file) {
  const errors = [];
  const name = sanitizeFilename(file.originalname);
  const ext = name.split('.').pop().toLowerCase();

  // Extension check
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    errors.push(`Unsupported file type: .${ext}. Supported: ${SUPPORTED_EXTENSIONS.map(e => '.' + e).join(', ')}`);
  }

  // MIME check (lenient — browsers vary)
  if (SUPPORTED_EXTENSIONS.includes(ext) && file.mimetype) {
    const allowed = ALLOWED_MIMES[ext] || [];
    if (allowed.length && !allowed.includes(file.mimetype)) {
      // Warn but don't block — rely on extension + actual parsing
      // Some browsers send incorrect MIME types for certain formats
    }
  }

  // Size check
  if (file.size > MAX_FILE_SIZE) {
    errors.push(`File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB. Maximum: ${MAX_FILE_SIZE / (1024 * 1024)} MB`);
  }

  // Empty file check
  if (file.size === 0) {
    errors.push('File is empty');
  }

  return errors;
}

// ────────────────────────────────────────────────────────────
// Apply defaults to legacy doc records (backward compatibility)
// ────────────────────────────────────────────────────────────

function migrateLegacyDoc(doc) {
  const ext = (doc.type || doc.extension || '').toLowerCase();
  return {
    ...doc,
    documentId: doc.documentId || doc.id,
    originalFilename: doc.originalFilename || doc.name,
    extension: doc.extension || ext,
    mimeType: doc.mimeType || MIME_MAP[ext] || 'application/octet-stream',
    size: doc.size || 0,
    hash: doc.hash || null,
    pageCount: doc.pageCount !== undefined ? doc.pageCount : null,
    slideCount: doc.slideCount !== undefined ? doc.slideCount : null,
    unitLabel: doc.unitLabel || getUnitLabel(ext),
    status: doc.status || 'ready',
    processingStatus: doc.processingStatus || 'completed',
    indexingStatus: doc.indexingStatus || 'completed',
    processedAt: doc.processedAt || doc.uploadedAt || null,
    processingError: doc.processingError || null
  };
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  MIME_MAP,
  ALLOWED_MIMES,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
  generateDocumentId,
  computeFileHash,
  sanitizeFilename,
  getUnitLabel,
  buildDocumentMeta,
  validateFile,
  migrateLegacyDoc
};
