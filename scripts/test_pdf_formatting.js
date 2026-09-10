const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { generateFile, normalizeExportMarkdown, buildStructuredDocument, recoverFlattenedListHeading } = require('../lib/fileGenerators');

async function run() {
  const malformed = `# Knowledge Studio Capability Report\n\n## Core Features\n- Role-based access control\n- Document management\n\nB\ne\ns\nt\nA\nP\nI\ns\n—\nC\no\ns\nt\n\nKnowledge Studio Page 1 of 1\n\n## References\n- Source: Case Studies`;
  const normalized = normalizeExportMarkdown(malformed);
  assert.ok(normalized.includes('Role-based access control'));
  assert.ok(!normalized.includes('B\ne\ns\nt'));
  assert.ok(!normalized.includes('Knowledge Studio Page 1 of 1'));

  const draft = `# Explanation of Travclan Business Analyst Summary Report\n\n# 2. Discount Intensity Analysis ## Discount Intensity = Discount Amount / Total Amount\n\nBusiness Insight OTA channels have high-discount costs.\n\n# Strategic Recommendations ## Recommendation 4 Implement validation controls. Expected Outcome: Improved data quality.\n\n# Conclusion Revenue leakage can be reduced through data - driven decisions.\n\n# Strategic Recommendations ## Recommendation 4 Implement validation controls. Expected Outcome: Improved data quality.\n\n# Conclusion Revenue leakage can be reduced through data - driven decisions.`;
  const polished = normalizeExportMarkdown(draft);
  assert.ok(polished.startsWith('# Travclan Business Analyst Summary Report'));
  assert.ok(polished.includes('## Discount Intensity Analysis'));
  assert.ok(polished.includes('### Business Insight:'));
  assert.ok(polished.includes('## Recommendation 4'));
  assert.ok(polished.includes('data-driven decisions'));
  assert.strictEqual((polished.match(/## Conclusion/g) || []).length, 1);

  const result = await generateFile('pdf', malformed, 'Capability Report');
  assert.strictEqual(result.buffer.subarray(0, 5).toString(), '%PDF-');
  const pdfText = (await pdfParse(result.buffer)).text;
  assert.ok(pdfText.includes('Role-based access control'));
  assert.ok(!pdfText.includes('B\ne\ns\nt'));
  assert.strictEqual((await pdfParse(result.buffer)).numpages, 1, 'Footer must not create blank pages');

  const structured = buildStructuredDocument(`# Report\n\n## Analysis\n\nA paragraph with 7.30% and an em dash — preserved.\n\n- First item\n- Second item\n\n1. First recommendation\n2. Second recommendation\n\n| Metric | Result |\n| --- | --- |\n| Value | 21% |`, 'Report', { sourceDocuments: [{ name: 'Grounded Source.pdf' }] });
  assert.strictEqual(structured.title, 'Report');
  assert.ok(structured.sections.some(section => section.heading === 'Analysis'));
  assert.ok(structured.sections.some(section => section.nodes.some(node => node.type === 'table')));

  const recovered = recoverFlattenedListHeading('Access Controls-User Login-User Roles-Role-Based Access Control (RBAC)-Document-Level Permissions');
  assert.ok(recovered);
  assert.strictEqual(recovered.heading, 'Access Controls');
  assert.deepStrictEqual(recovered.items, ['User Login', 'User Roles', 'Role-Based Access Control (RBAC)', 'Document-Level Permissions']);

  const inspectionPath = path.join(__dirname, '..', 'scratch', 'pdf-formatting-inspection.pdf');
  fs.mkdirSync(path.dirname(inspectionPath), { recursive: true });
  fs.writeFileSync(inspectionPath, result.buffer);

  const controlledMarkdown = `# PDF Renderer Validation\n\n## Plain Paragraph\n\nThis paragraph verifies readable Unicode and punctuation: PostgreSQL + pgVector, React.js / Next.js, PDF / DOCX / PPTX, 5.84%, 21%, 0.61%, $1.00, hyphenated-text, “quotation marks”, an en dash – and an em dash —.\n\n## Bullet List\n\n- User Login\n- User Roles\n- Role-Based Access Control (RBAC)\n- Document-Level Permissions\n\n## Numbered List\n\n1. Validate grounded evidence\n2. Build a structured document model\n3. Render a professional PDF\n\n## Two-Column Table\n\n| Metric | Result |\n| --- | --- |\n| Discount Intensity | 7.30% |\n| Coupon Revenue Difference | Approximately 21% lower |\n\n## Three-Column Technology Table\n\n| Layer | Technology | Purpose |\n| --- | --- | --- |\n| Frontend | React.js / Next.js | User and administrator portal with role-aware access. |\n| Backend | FastAPI or application API layer | Business logic, authorization, and document workflows. |\n| Search | PostgreSQL + pgVector | Grounded retrieval, vector storage, and semantic search. |\n\n## Sources\n\n- Grounded Source.pdf`;
  const controlled = await generateFile('pdf', controlledMarkdown, 'PDF Renderer Validation', { sourceDocuments: [{ name: 'Grounded Source.pdf' }] });
  const controlledParsed = await pdfParse(controlled.buffer);
  for (const expected of ['Plain Paragraph', 'Role-Based Access Control', 'Validate grounded evidence', 'Discount Intensity', 'PostgreSQL + pgVector', 'Grounded Source.pdf']) {
    assert.ok(controlledParsed.text.includes(expected), `PDF must contain ${expected}`);
  }
  assert.strictEqual((controlledParsed.text.match(/Grounded Source\.pdf/g) || []).length, 1, 'Sources must not be duplicated');
  assert.ok(controlledParsed.numpages >= 1 && controlledParsed.numpages <= 3, 'Controlled PDF page count is reasonable');
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', 'pdf-controlled-renderer.pdf'), controlled.buffer);

  const wideTable = await generateFile('pdf', `# Wide Table Validation\n\n| A | B | C | D | E | F |\n| --- | --- | --- | --- | --- | --- |\n| One | Two | Three | Four | Five | Six |`, 'Wide Table Validation');
  const wideParsed = await pdfParse(wideTable.buffer);
  for (const expected of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) assert.ok(wideParsed.text.includes(expected));
  console.log('[PASS] Corrupted vertical text and source footers are excluded from PDF exports.');
  console.log('[PASS] Structured PDF model, Unicode, lists, table text extraction, and pagination verified.');
}

run().catch(error => {
  console.error('[FAIL] PDF formatting test:', error.message);
  process.exit(1);
});
