const fs = require('fs');
const path = require('path');

const KB_PATH = path.join(__dirname, '..', 'data', 'kb.json');
const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');

// ────────────────────────────────────────────────────────────
// Load knowledge base
// ────────────────────────────────────────────────────────────

function loadKB() {
  if (!fs.existsSync(KB_PATH)) return { docs: [], chunks: [] };
  try {
    return JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  } catch {
    return { docs: [], chunks: [] };
  }
}

// ────────────────────────────────────────────────────────────
// Save knowledge base (atomic write: temp file → rename)
// ────────────────────────────────────────────────────────────

function saveKB(kb) {
  const dir = path.dirname(KB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = KB_PATH + '.tmp_' + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(kb, null, 2));
    // Atomic rename — if this fails, the original kb.json is untouched
    fs.renameSync(tmpPath, KB_PATH);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
// Backup knowledge base before destructive operations
// ────────────────────────────────────────────────────────────

function backupKB() {
  if (!fs.existsSync(KB_PATH)) return null;

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const now = new Date();
  const stamp = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + '-'
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');

  const backupPath = path.join(BACKUPS_DIR, `kb-${stamp}.json`);

  // Don't overwrite an existing backup from the same second
  if (fs.existsSync(backupPath)) return backupPath;

  fs.copyFileSync(KB_PATH, backupPath);
  console.log(`[kbStore] Backup created: ${backupPath}`);
  return backupPath;
}

// ────────────────────────────────────────────────────────────
// Find duplicate by SHA-256 hash
// ────────────────────────────────────────────────────────────

function findDuplicateByHash(kb, hash) {
  if (!hash) return null;
  return kb.docs.find(d => d.hash === hash) || null;
}

module.exports = { loadKB, saveKB, backupKB, findDuplicateByHash, KB_PATH, BACKUPS_DIR };
