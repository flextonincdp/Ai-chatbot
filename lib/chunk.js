function normalizeText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseHeading(block) {
  const match = String(block || '').match(/^(#{1,6})\s+(.+)$/);
  return match ? { level: match[1].length, text: match[2].trim() } : null;
}

function headingMetadata(headings, content) {
  const numbered = [...headings].reverse().find(heading => /^(\d+(?:\.\d+)*)(?:[.)])?\s+/.test(heading.text));
  const current = headings[headings.length - 1] || null;
  const numberedMatch = numbered && numbered.text.match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/);
  const contentLines = String(content || '').split('\n').map(line => line.trim()).filter(Boolean);
  return {
    headingPath: headings.map(heading => heading.text),
    parentHeadings: headings.slice(0, -1).map(heading => heading.text),
    sectionNumber: numberedMatch ? numberedMatch[1] : null,
    sectionTitle: numberedMatch ? numberedMatch[2] : (current ? current.text : null),
    headingLevel: current ? current.level : null,
    contentType: contentLines.every(line => /^(?:[-*â€¢â—¦â–ªâ€“â€”])\s+/.test(line)) ? 'bullet_list' : (String(content || '').includes('|') ? 'table' : 'text')
  };
}

function contextPrefix(headings) {
  return headings.map(heading => `${'#'.repeat(heading.level)} ${heading.text}`).join('\n\n');
}

/** Chunk structured Markdown while retaining heading ancestry and section metadata. */
function chunkStructuredText(text, chunkSize = 900, overlap = 150) {
  const clean = normalizeText(text);
  if (!clean) return [];
  const blocks = clean.split(/\n\n+/).map(value => value.trim()).filter(Boolean);
  const chunks = [];
  const headings = [];
  let current = [];
  let currentLength = 0;
  const flush = () => {
    const content = current.join('\n\n').trim();
    if (content.length >= 20) {
      const prefix = contextPrefix(headings);
      const value = `${prefix}${prefix ? '\n\n' : ''}${content}`.trim();
      if (!chunks.some(chunk => chunk.text === value)) chunks.push({ text: value, metadata: headingMetadata(headings, content) });
    }
    current = []; currentLength = 0;
  };
  const add = value => { current.push(value); currentLength += value.length + (current.length > 1 ? 2 : 0); };
  for (const block of blocks) {
    const heading = parseHeading(block);
    if (heading) {
      flush();
      while (headings.length && headings[headings.length - 1].level >= heading.level) headings.pop();
      headings.push(heading);
      continue;
    }
    if (/^<!-- (?:PAGE|SLIDE) \d+ -->$/.test(block)) { flush(); continue; }
    if (block.length <= chunkSize) {
      if (current.length && currentLength + block.length + 2 > chunkSize) flush();
      add(block);
      continue;
    }
    const units = block.includes('\n') ? block.split('\n') : block.split(/(?<=[.!?])\s+/);
    for (const unit of units) {
      const cleanUnit = unit.trim();
      if (!cleanUnit) continue;
      if (current.length && currentLength + cleanUnit.length + 1 > chunkSize) {
        const tail = current.join('\n\n').slice(-overlap).trim();
        flush();
        if (tail) add(tail);
      }
      add(cleanUnit);
    }
  }
  flush();
  return chunks;
}

function chunkText(text, chunkSize = 900, overlap = 150) {
  return chunkStructuredText(text, chunkSize, overlap).map(chunk => chunk.text);
}

module.exports = { chunkText, chunkStructuredText };
