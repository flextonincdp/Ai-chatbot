/**
 * Small, dependency-free helpers for fitting text in generated SVGs. SVG does
 * not wrap <text> nodes automatically, so labels must be split into tspans.
 */
function escapeXml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>&'"]/g, character => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  }[character]));
}

function wrapText(value, maxChars, maxLines = Infinity) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  const lines = [];
  let line = '';
  for (const word of words) {
    // Split an unbroken URL or identifier rather than allowing it to escape.
    const pieces = word.length > maxChars
      ? word.match(new RegExp(`.{1,${maxChars}}`, 'g'))
      : [word];
    for (const piece of pieces) {
      const candidate = line ? `${line} ${piece}` : piece;
      if (candidate.length <= maxChars) {
        line = candidate;
      } else {
        lines.push(line);
        line = piece;
      }
    }
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[\s.]+$/, '')}\u2026`;
  return visible;
}

function multilineText({ text, x, centerY, fill, fontSize, fontWeight = 'normal', textAnchor = 'middle', maxChars, maxLines, lineHeight, fontFamily }) {
  const lines = wrapText(text, maxChars, maxLines);
  const lineGap = lineHeight || Math.round(fontSize * 1.25);
  const firstBaseline = centerY - ((lines.length - 1) * lineGap) / 2;
  const family = fontFamily ? ` font-family="${fontFamily}"` : '';
  const spans = lines.map((line, index) =>
    `<tspan x="${x}" dy="${index === 0 ? 0 : lineGap}">${escapeXml(line)}</tspan>`
  ).join('');

  return `<text x="${x}" y="${firstBaseline}" fill="${fill}" font-size="${fontSize}px" font-weight="${fontWeight}" text-anchor="${textAnchor}" dominant-baseline="central"${family}>${spans}</text>`;
}

function parseFontSize(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = { escapeXml, wrapText, multilineText, parseFontSize };
