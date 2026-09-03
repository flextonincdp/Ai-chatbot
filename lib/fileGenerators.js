// Turns the AI-drafted markdown-lite text (from buildExportPrompt) into a real,
// downloadable file: .txt, .docx, .pptx, or .pdf.
//
// The parsing here is intentionally simple: it looks for
//   "# Title"       -> h1
//   "## Heading"    -> h2
//   "- item"/"* item" -> bullet
//   anything else non-blank -> paragraph
// which is exactly the shape buildExportPrompt() asks the model to produce.

const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } = require('docx');
const PptxGenJS = require('pptxgenjs');
const PDFDocument = require('pdfkit');
const { resolveTheme } = require('./svgGenerator/themes');

function parseBlocks(markdown) {
  // Convert HTML to markdown to handle cases where the LLM outputs HTML instead of markdown
  let processed = (markdown || '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''); // Strip all other remaining HTML tags
    
  const lines = processed.split(/\r?\n/);
  const blocks = [];
  let pendingBullet = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^(?:[-*]|•)$/.test(line)) {
      pendingBullet = true;
      continue;
    }
    if (pendingBullet) {
      blocks.push({ type: 'bullet', text: line.replace(/^[-*•]\s*/, '') });
      pendingBullet = false;
      continue;
    }
    if (line.includes('|')) {
      const rows = [];
      while (index < lines.length && lines[index].trim().includes('|')) {
        const cells = lines[index].trim().split('|').map(cell => cell.trim()).filter((cell, cellIndex, all) => !(cellIndex === 0 && cell === '') && !(cellIndex === all.length - 1 && cell === ''));
        if (cells.length > 0 && !cells.every(cell => /^:?-{3,}:?$/.test(cell))) rows.push(cells);
        index++;
      }
      index--;
      if (rows.length > 0) blocks.push({ type: 'table', rows });
      continue;
    }
    if (line.startsWith('# ')) blocks.push({ type: 'h1', text: line.slice(2).trim() });
    else if (line.startsWith('## ')) blocks.push({ type: 'h2', text: line.slice(3).trim() });
    else if (line.startsWith('### ')) blocks.push({ type: 'h3', text: line.slice(4).trim() });
    else if (/^[-*]\s+/.test(line)) blocks.push({ type: 'bullet', text: line.replace(/^[-*]\s+/, '') });
    else blocks.push({ type: 'p', text: line });
  }
  return blocks;
}

function extractTitle(blocks, fallback) {
  const h1 = blocks.find(b => b.type === 'h1');
  return h1 ? h1.text : fallback;
}

function blockText(block) {
  if (!block) return '';
  if (block.type === 'table') return (block.rows || []).map(row => row.join(' | ')).join('\n');
  return String(block.text || '');
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function normalizeDocumentConfig(config = {}) {
  const aliases = {
    formal: 'professional',
    simple: 'minimal',
    management: 'executive',
    meeting: 'executive',
    technical: 'technology'
  };
  const templateThemes = {
    executive_summary: 'executive',
    meeting_summary: 'executive',
    presentation: 'executive',
    technical_report: 'technology',
    client_report: 'corporate',
    business_proposal: 'corporate',
    simple_document: 'minimal'
  };
  const requestedTheme = aliases[String(config.theme || '').toLowerCase()] || String(config.theme || '').toLowerCase();
  const theme = requestedTheme && requestedTheme !== 'auto'
    ? requestedTheme
    : (templateThemes[config.template] || 'professional');
  return {
    ...config,
    theme,
    palette: config.palette || 'auto'
  };
}

// ---------- TXT ----------
function toTxt(markdown) {
  return Buffer.from(markdown, 'utf8');
}

// ---------- DOCX ----------
async function toDocx(markdown, title, docConfig) {
  const theme = resolveTheme(docConfig.theme, docConfig.palette);
  const palette = theme.palette;
  const blocks = parseBlocks(markdown);
  const children = blocks.map(b => {
    if (b.type === 'table') {
      const columnCount = Math.max(1, ...b.rows.map(row => row.length));
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((row, rowIndex) => new TableRow({
          tableHeader: rowIndex === 0,
          children: Array.from({ length: columnCount }, (_, columnIndex) => new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: row[columnIndex] || '', bold: rowIndex === 0 })]
            })]
          }))
        }))
      });
    }
    const cleanText = b.text.replace(/\*\*/g, '');
    if (b.type === 'h1') return new Paragraph({ text: cleanText, heading: HeadingLevel.TITLE });
    if (b.type === 'h2') return new Paragraph({ text: cleanText, heading: HeadingLevel.HEADING_1 });
    if (b.type === 'h3') return new Paragraph({ text: cleanText, heading: HeadingLevel.HEADING_2 });
    if (b.type === 'bullet') return new Paragraph({ text: cleanText, bullet: { level: 0 } });
    return new Paragraph({ children: [new TextRun(cleanText)], spacing: { after: 160 } });
  });
  const doc = new Document({
    title: title || 'Document',
    styles: {
      default: {
        document: {
          run: { color: palette.text.replace('#', ''), font: theme.fontFamily.split(',')[0].replace(/['"]/g, '') }
        }
      },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { color: palette.primary.replace('#', ''), size: parseInt(theme.titleFontSize)*2, bold: true }, paragraph: { spacing: { after: 240 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { color: palette.secondary.replace('#', ''), size: 32, bold: true }, paragraph: { spacing: { before: 240, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { color: palette.text.replace('#', ''), size: 28, bold: true }, paragraph: { spacing: { before: 240, after: 120 } } }
      ]
    },
    sections: [{ properties: {}, children }]
  });
  return Packer.toBuffer(doc);
}

// ---------- PPTX ----------
// Splits into slides at every h1/h2. Bullets & paragraphs under a heading
// become that slide's body content.
async function toPptx(markdown, title, docConfig) {
  const theme = resolveTheme(docConfig.theme, docConfig.palette);
  const palette = theme.palette;
  const fontFace = theme.fontFamily.split(',')[0].replace(/['"]/g, '');
  const blocks = parseBlocks(markdown);
  const pres = new PptxGenJS();
  pres.defineLayout({ name: 'WIDE', width: 10, height: 5.63 });
  pres.layout = 'WIDE';

  let slides = [];
  let current = null;
  for (const b of blocks) {
    if (b.type === 'h1' || b.type === 'h2') {
      current = { title: b.text, body: [] };
      slides.push(current);
    } else {
      if (!current) { current = { title: title || 'Document', body: [] }; slides.push(current); }
      current.body.push(b.type === 'table' ? { type: 'p', text: b.rows.map(row => row.join(' | ')).join('\n') } : b);
    }
  }
  if (!slides.length) slides.push({ title: title || 'Document', body: [{ type: 'p', text: markdown.slice(0, 500) }] });

  // Title slide first
  const first = pres.addSlide();
  first.background = { color: palette.primary.replace('#', '') };
  first.addText(title || slides[0].title || 'Document', {
    x: 0.5, y: 2.1, w: 9, h: 1.4, fontSize: parseInt(theme.titleFontSize), bold: true, color: 'FFFFFF', fontFace
  });

  for (const s of slides) {
    const slide = pres.addSlide();
    slide.background = { color: palette.background.replace('#', '') };
    // Title is already h1 or h2, clean it up just in case
    const safeTitle = (s.title || '').replace(/\*\*/g, '');
    slide.addText(safeTitle, { x: 0.5, y: 0.35, w: 9, h: 0.8, fontSize: 26, bold: true, color: palette.primary.replace('#', ''), fontFace });
    if (s.body.length) {
      const textRuns = s.body.slice(0, 8).map(b => {
        let isBold = b.text.startsWith('**') && b.text.endsWith('**');
        let cleanText = b.text.replace(/\*\*/g, '');
        return {
          text: cleanText,
          options: { bullet: b.type === 'bullet', bold: isBold, breakLine: true, fontSize: isBold ? 18 : 16, color: palette.text.replace('#', '') }
        };
      });
      slide.addText(textRuns, { x: 0.5, y: 1.3, w: 9, h: 3.9, valign: 'top', fontFace });
    }
  }

  // Embed diagram slide if passed
  if (docConfig.embeddedDiagram) {
    const slide = pres.addSlide();
    slide.background = { color: palette.background.replace('#', '') };
    slide.addText(docConfig.embeddedDiagram.title || 'Diagram', { x: 0.5, y: 0.35, w: 9, h: 0.8, fontSize: 26, bold: true, color: palette.primary.replace('#', ''), fontFace });
    
    if (docConfig.embeddedDiagram.data && docConfig.embeddedDiagram.data.nodes) {
       let yPos = 1.5;
       for (const node of docConfig.embeddedDiagram.data.nodes.slice(0, 5)) {
          slide.addShape(pres.ShapeType.rect, { x: 1.0, y: yPos, w: 2.5, h: 0.6, fill: { color: palette.primary.replace('#','') }, line: { color: '000000' } });
          slide.addText(node.label, { x: 1.0, y: yPos, w: 2.5, h: 0.6, fontSize: 14, color: 'FFFFFF', align: 'center', bold: true });
          yPos += 0.8;
       }
       slide.addText('(Diagram Structure Retained - Convert SVG for native visual)', { x: 4.0, y: 2.5, w: 5, h: 1, fontSize: 14, color: palette.text.replace('#', '') });
    }
  }

  // Embed chart slide if passed
  if (docConfig.embeddedChart && docConfig.embeddedChart.data && docConfig.embeddedChart.data.length > 0) {
    const slide = pres.addSlide();
    slide.background = { color: palette.background.replace('#', '') };
    slide.addText(docConfig.embeddedChart.title || 'Data Chart', { x: 0.5, y: 0.35, w: 9, h: 0.8, fontSize: 26, bold: true, color: palette.primary.replace('#', ''), fontFace });
    
    // Prepare data for pptxgenjs
    const chartLabels = docConfig.embeddedChart.data.map(d => d.label);
    const chartValues = docConfig.embeddedChart.data.map(d => Number(d.value) || 0);

    const chartData = [
      {
        name: 'Values',
        labels: chartLabels,
        values: chartValues
      }
    ];

    slide.addChart(pres.ChartType.bar, chartData, {
       x: 1.0, y: 1.3, w: 8, h: 3.8,
       showLegend: true,
       chartColors: [palette.primary.replace('#', '')]
    });
  }

  return pres.write({ outputType: 'nodebuffer' });
}

// ---------- PDF ----------
function toPdf(markdown, title, docConfig) {
  return new Promise((resolve, reject) => {
    const theme = resolveTheme(docConfig.theme, docConfig.palette);
    const palette = theme.palette;
    const blocks = parseBlocks(markdown);
    // Margins set to ~0.75 inch (54 points)
    const doc = new PDFDocument({ margin: 58, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fontName = theme.fontFamily.toLowerCase().includes('serif') ? 'Times-Roman' : 'Helvetica';
    const fontBold = theme.fontFamily.toLowerCase().includes('serif') ? 'Times-Bold' : 'Helvetica-Bold';

    doc.on('pageAdded', () => {
      doc.y = 58;
    });

    const renderTable = rows => {
      if (!rows || !rows.length) return;
      const columnCount = Math.max(1, ...rows.map(row => row.length));
      const tableX = doc.page.margins.left;
      const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const columnWidth = tableWidth / columnCount;
      const pageBottom = () => doc.page.height - doc.page.margins.bottom - 24;
      const drawRow = (row, isHeader) => {
        const font = isHeader ? fontBold : fontName;
        const fontSize = 8.5;
        const heights = Array.from({ length: columnCount }, (_, column) => {
          doc.font(font).fontSize(fontSize);
          return doc.heightOfString(row[column] || '', { width: columnWidth - 10, lineGap: 1 }) + 12;
        });
        const rowHeight = Math.max(22, ...heights);
        if (doc.y + rowHeight > pageBottom() && doc.y > doc.page.margins.top + 2) {
          doc.addPage();
          if (!isHeader) drawRow(rows[0], true);
        }
        const y = doc.y;
        for (let column = 0; column < columnCount; column++) {
          const x = tableX + column * columnWidth;
          doc.save().fillColor(isHeader ? palette.primary : '#ffffff').strokeColor(palette.border || '#d9dde3')
            .rect(x, y, columnWidth, rowHeight).fillAndStroke().restore();
          doc.fillColor(isHeader ? '#ffffff' : palette.text).font(font).fontSize(fontSize)
            .text(row[column] || '', x + 5, y + 6, { width: columnWidth - 10, lineGap: 1 });
        }
        doc.y = y + rowHeight;
      };
      if (doc.y + 22 > pageBottom() && doc.y > doc.page.margins.top + 2) doc.addPage();
      drawRow(rows[0], true);
      rows.slice(1).forEach(row => drawRow(row, false));
      doc.moveDown(0.6);
    };

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const isLast = i === blocks.length - 1;
      if (b.type === 'table') {
        renderTable(b.rows);
        continue;
      }
      const cleanText = b.text.replace(/\*\*/g, '');
      if (b.type === 'h1') {
        doc.fillColor(palette.primary).font(fontBold).fontSize(22).text(cleanText, { paragraphGap: 7 });
        doc.moveDown(0.2).strokeColor(palette.border || palette.primary).lineWidth(1).moveTo(doc.x, doc.y).lineTo(554, doc.y).stroke().moveDown(0.7);
      } else if (b.type === 'h2') {
        doc.fillColor(palette.secondary).font(fontBold).fontSize(15).text(cleanText, { paragraphGap: 7, lineGap: 1 });
      } else if (b.type === 'h3') {
        doc.fillColor(palette.text).font(fontBold).fontSize(12).text(cleanText, { paragraphGap: 5, lineGap: 1 });
      } else if (b.type === 'bullet') {
        const bulletY = doc.y + 4;
        doc.fillColor(palette.primary).circle(doc.x + 3, bulletY, 2.2).fill();
        doc.fillColor(palette.text).font(fontName).fontSize(10.5).text(cleanText, {
          x: doc.x + 16, width: 470, paragraphGap: isLast ? 0 : 5, lineGap: 2
        });
      } else {
        // If it was bold in markdown, render as bold in PDF (e.g. Page numbers)
        const isBold = b.text.startsWith('**') && b.text.endsWith('**');
        doc.fillColor(palette.text).font(isBold ? fontBold : fontName).fontSize(10).text(cleanText, { align: 'left', paragraphGap: isLast ? 0 : 8, lineGap: 1.5 });
      }
    }
    if (Array.isArray(docConfig.sourceDocuments) && docConfig.sourceDocuments.length > 0) {
      doc.moveDown(0.8).fillColor(palette.secondary).font(fontBold).fontSize(13).text('Sources', { paragraphGap: 7 });
      docConfig.sourceDocuments.forEach(source => {
        doc.fillColor(palette.text).font(fontName).fontSize(9.5).text(source.name, { indent: 12, paragraphGap: 3 });
      });
    }

    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
      doc.switchToPage(page);
      doc.save().fillColor(palette.text).font(fontName).fontSize(8)
        .text('Knowledge Studio', 58, 720, { width: 240, align: 'left' })
        .text(`Page ${page - range.start + 1} of ${range.count}`, 314, 720, { width: 240, align: 'right' })
        .restore();
    }
    doc.end();
  });
}

const MIME = {
  txt:  'text/plain',
  md:   'text/markdown',
  html: 'text/html',
  json: 'application/json',
  csv:  'text/csv',
  tsv:  'text/tab-separated-values',
  rtf:  'application/rtf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods:  'application/vnd.oasis.opendocument.spreadsheet',
  pdf:  'application/pdf'
};

// ---------- HTML ----------
function toHtml(markdown, title, docConfig) {
  const theme = resolveTheme(docConfig.theme, docConfig.palette);
  const palette = theme.palette;
  const blocks = parseBlocks(markdown);
  const bodyHtml = blocks.map(b => {
    if (b.type === 'table') {
      const rows = b.rows.map((row, rowIndex) => `<tr>${row.map(cell => `<${rowIndex === 0 ? 'th' : 'td'}>${escHtml(cell)}</${rowIndex === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('');
      return `<table>${rows}</table>`;
    }
    if (b.type === 'h1')     return `<h1>${escHtml(b.text)}</h1>`;
    if (b.type === 'h2')     return `<h2>${escHtml(b.text)}</h2>`;
    if (b.type === 'h3')     return `<h3>${escHtml(b.text)}</h3>`;
    if (b.type === 'bullet') return `<li>${escHtml(b.text)}</li>`;
    return `<p>${escHtml(b.text)}</p>`;
  });
  // Wrap adjacent <li> in <ul>
  let html = '';
  let inList = false;
  for (const tag of bodyHtml) {
    if (tag.startsWith('<li>') && !inList) { html += '<ul>\n'; inList = true; }
    if (!tag.startsWith('<li>') && inList) { html += '</ul>\n'; inList = false; }
    html += tag + '\n';
  }
  if (inList) html += '</ul>\n';

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title || 'Document')}</title>
<style>
  body { 
    font-family: ${theme.fontFamily}; 
    background-color: ${palette.background};
    color: ${palette.text};
    max-width: 800px; 
    margin: 40px auto; 
    padding: 0 24px; 
    line-height: 1.7; 
  }
  h1 { 
    font-size: ${theme.titleFontSize || '2em'}; 
    border-bottom: 2px solid ${palette.border}; 
    padding-bottom: 12px; 
    margin-bottom: 16px; 
    color: ${palette.primary}; 
  }
  h2 { font-size: 1.4em; margin-top: 32px; color: ${palette.secondary}; }
  h3 { font-size: 1.1em; margin-top: 20px; color: ${palette.text}; }
  p  { margin: 12px 0; }
  ul { padding-left: 24px; }
  li { margin: 6px 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { border: 1px solid ${palette.border}; padding: 8px; text-align: left; vertical-align: top; }
  th { background: ${palette.primary}; color: #fff; }
</style>
</head>
<body>
${html}
</body>
</html>`;
  return Buffer.from(page, 'utf8');
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------- JSON ----------
function toJson(markdown, title) {
  const blocks = parseBlocks(markdown);
  const obj = { title, sections: [] };
  let current = null;
  for (const b of blocks) {
    if (b.type === 'h1') { obj.title = b.text; }
    else if (b.type === 'h2') { current = { heading: b.text, content: [] }; obj.sections.push(current); }
    else { if (!current) { current = { heading: '', content: [] }; obj.sections.push(current); } current.content.push({ type: b.type, text: b.text }); }
  }
  return Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
}

// ---------- CSV ----------
function toCsv(markdown, title) {
  const blocks = parseBlocks(markdown);
  const tables = blocks.filter(block => block.type === 'table' && block.rows && block.rows.length);
  if (tables.length) {
    // CSV has one tabular shape. Preserve the first real table verbatim rather
    // than flattening it into prose or inventing columns.
    return Buffer.from(tables[0].rows.map(row => row.map(csvCell).join(',')).join('\n'), 'utf8');
  }
  const rows = [['Type', 'Content']];
  for (const b of blocks) {
    rows.push([b.type, csvCell(blockText(b))]);
  }
  return Buffer.from(rows.map(r => r.join(',')).join('\n'), 'utf8');
}

// ---------- XLSX / ODS ----------
const XLSX = require('xlsx');

function toXlsx(markdown, title, bookType = 'xlsx', docConfig = {}) {
  const blocks = parseBlocks(markdown);
  const workbook = XLSX.utils.book_new();
  
  const rows = [[title || 'Report', ''], ['Source / Heading', 'Content']];
  let currentContext = '';
  
  for (const b of blocks) {
    if (b.type === 'h1') {
       // The title is also retained in the worksheet for a clear first view.
    } else if (b.type === 'h2' || b.type === 'h3') {
       currentContext = b.text.replace(/\*\*/g, ''); // strip bold
       rows.push(['', '']);
       rows.push([currentContext.toUpperCase(), '']);
     } else if (b.type === 'table') {
       for (const row of b.rows) rows.push(row);
     } else if (b.text.startsWith('|')) {
       // Tabular data parsing
       const cells = b.text.split('|').map(s => s.trim()).filter((s, i, arr) => !(i === 0 && s === '') && !(i === arr.length - 1 && s === ''));
       if (!cells.every(c => c.match(/^-+$/))) { // skip markdown separator row
          rows.push(cells);
       }
    } else {
       let cleanText = b.text.replace(/\*\*/g, '');
       if (b.type === 'bullet') cleanText = '• ' + cleanText;
       rows.push([currentContext, cleanText]);
    }
  }
  
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 25 }, { wch: 100 }];
  
  // Wrap text for content column
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell_address = { c: C, r: R };
      const cell_ref = XLSX.utils.encode_cell(cell_address);
      if (!worksheet[cell_ref]) continue;
      if (!worksheet[cell_ref].s) worksheet[cell_ref].s = {};
      worksheet[cell_ref].s.alignment = { wrapText: true, vertical: 'top' };
    }
  }

  const safeTitle = (title || 'Report').substring(0, 31).replace(/[\\/?*\[\]]/g, '');
  XLSX.utils.book_append_sheet(workbook, worksheet, safeTitle);
  if (Array.isArray(docConfig.sourceDocuments) && docConfig.sourceDocuments.length > 0) {
    const sourcesSheet = XLSX.utils.aoa_to_sheet([
      ['Source Document'],
      ...docConfig.sourceDocuments.map(source => [source.name])
    ]);
    sourcesSheet['!cols'] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(workbook, sourcesSheet, 'Sources');
  }
  return XLSX.write(workbook, { type: 'buffer', bookType });
}

// ---------- TSV ----------
function toTsv(markdown, title) {
  const blocks = parseBlocks(markdown);
  const tables = blocks.filter(block => block.type === 'table' && block.rows && block.rows.length);
  if (tables.length) return Buffer.from(tables[0].rows.map(row => row.map(cell => String(cell ?? '').replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n'), 'utf8');
  const rows = [['Type', 'Content']];
  for (const b of blocks) {
    const safe = blockText(b).replace(/[\t\r\n]/g, ' ');
    rows.push([b.type, safe]);
  }
  return Buffer.from(rows.map(r => r.join('\t')).join('\n'), 'utf8');
}

// ---------- RTF ----------
function toRtf(markdown, title) {
  const blocks = parseBlocks(markdown);
  let rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\n';
  rtf += '{\\*\\generator KnowledgeStudio;}\\viewkind4\\uc1 \n';
  rtf += '\\pard\\sa200\\sl276\\slmult1\\f0\\fs22\\lang9\n';
  for (const b of blocks) {
    const safeText = blockText(b).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
    if (b.type === 'h1') rtf += '\\b\\fs32 ' + safeText + '\\par\\b0\\fs22\n';
    else if (b.type === 'h2') rtf += '\\b\\fs28 ' + safeText + '\\par\\b0\\fs22\n';
    else if (b.type === 'h3') rtf += '\\b\\fs24 ' + safeText + '\\par\\b0\\fs22\n';
    else if (b.type === 'bullet') rtf += '\\bullet\\tab ' + safeText + '\\par\n';
    else rtf += safeText + '\\par\n';
  }
  rtf += '}';
  return Buffer.from(rtf, 'utf8');
}

async function generateFile(format, markdown, titleHint, docConfig = { theme: 'professional', palette: 'blue' }) {
  docConfig = normalizeDocumentConfig(docConfig);
  const blocks = parseBlocks(markdown);
  const title = extractTitle(blocks, titleHint || 'Document');
  let buffer;
  if (format === 'txt')   buffer = toTxt(markdown);
  else if (format === 'md')   buffer = Buffer.from(markdown, 'utf8');
  else if (format === 'html') buffer = toHtml(markdown, title, docConfig);
  else if (format === 'json') buffer = toJson(markdown, title);
  else if (format === 'csv')  buffer = toCsv(markdown, title);
  else if (format === 'tsv')  buffer = toTsv(markdown, title);
  else if (format === 'rtf')  buffer = toRtf(markdown, title);
  else if (format === 'docx') buffer = await toDocx(markdown, title, docConfig);
  else if (format === 'pptx') buffer = await toPptx(markdown, title, docConfig);
  else if (format === 'pdf')  buffer = await toPdf(markdown, title, docConfig);
  else if (format === 'xlsx') buffer = toXlsx(markdown, title, 'xlsx', docConfig);
  else if (format === 'ods')  buffer = toXlsx(markdown, title, 'ods', docConfig);
  else throw new Error('Unsupported export format: ' + format);
  return { buffer, mime: MIME[format] || 'application/octet-stream', title };
}

module.exports = { generateFile, MIME };
