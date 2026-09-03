const assert = require('assert');
const fs = require('fs');
const { validateSemanticResult, resolveBestContext } = require('../lib/contextResolver');
const { selectRelevantChunks, validateAnswerGrounding } = require('../lib/retrieval');
const { generateFile } = require('../lib/fileGenerators');
const { generateSvg } = require('../lib/svgGenerator/generator');
const { getStorageProvider } = require('../lib/storage');

async function main() {
  const semantic = validateSemanticResult({
    contextRelation: 'REPRESENT', contextType: 'CURRENT_ANSWER', resolvedAnswerId: 'answer-a',
    resolvedArtifactId: null, intent: 'VISUALIZE', requestedFormat: 'SVG',
    topic: 'Core Features', confidence: 0.95, newInformationRequired: false
  });
  assert(semantic && semantic.contextRelation === 'REPRESENT');
  assert.strictEqual(validateSemanticResult({ intent: 'ANSWER' }), null);
  const styledArtifactIntent = validateSemanticResult({
    contextRelation: 'REPRESENT', contextType: 'CURRENT_ANSWER', resolvedAnswerId: 'answer-a',
    resolvedArtifactId: null, intent: 'CREATE', requestedFormat: 'PDF', topic: 'Case studies', confidence: 0.95,
    newInformationRequired: false, visualType: null, theme: 'executive', palette: 'navy', template: 'executive_summary',
    outputs: { text_answer: true, diagram: false, chart: false }
  });
  assert(styledArtifactIntent && styledArtifactIntent.theme === 'executive' && styledArtifactIntent.template === 'executive_summary');

  const history = [
    { id: 'a', answerId: 'answer-a', role: 'assistant', content: 'Core Features: User Login and AI Search', sourceIds: ['chunk-a'], sourceDocIds: ['doc-a'] },
    { id: 'b', answerId: 'answer-b', role: 'assistant', content: 'Security controls and access policies', sourceIds: ['chunk-b'], sourceDocIds: ['doc-b'] }
  ];
  assert.strictEqual(resolveBestContext('prepare security', history, {
    contextRelation: 'REPRESENT', contextType: 'CURRENT_ANSWER', resolvedAnswerId: 'b',
    intent: 'CREATE', confidence: 0.9, newInformationRequired: false
  }).messageId, 'b');

  const filtered = await selectRelevantChunks([
    { id: 'hotel-1', docId: 'hotel', docName: 'hotel.csv', text: 'Hotel booking records include reservation dates, room types, guest counts, and booking status.' },
    { id: 'case-1', docId: 'case', docName: 'case.docx', text: 'AI RAG and Summary provide document search, access control, and related case studies.' },
    { id: 'python-1', docId: 'python', docName: 'python.pdf', text: 'Python functions, modules, and programming language syntax.' }
  ], 'Explain the hotel booking data');
  assert.deepStrictEqual(filtered.map(chunk => chunk.id), ['hotel-1']);

  const sameTopic = await selectRelevantChunks([
    { id: 'security-1', docId: 'policy', docName: 'security-policy.pdf', text: 'Security controls require multifactor authentication and role-based access.' },
    { id: 'security-2', docId: 'deployment', docName: 'deployment-guide.pdf', text: 'Deployment security uses role-based access and multifactor authentication.' },
    { id: 'unrelated-1', docId: 'finance', docName: 'annual-report.pdf', text: 'Annual revenue and financial performance are reported by year.' }
  ], 'Compare security controls across the policy and deployment guide');
  assert.deepStrictEqual(sameTopic.map(chunk => chunk.id).sort(), ['security-1', 'security-2']);
  assert(await validateAnswerGrounding(
    '<p>Hotel bookings include reservation dates and room types. (Source: hotel.csv)</p>',
    'Explain hotel booking data',
    [{ text: 'Hotel booking records include reservation dates and room types.' }]
  ));
  assert(!(await validateAnswerGrounding(
    '<p>Python modules define reusable programming functions.</p>',
    'Explain hotel booking data',
    [{ text: 'Hotel booking records include reservation dates and room types.' }]
  )));

  const answer = '# Core Features\n\n## Capabilities\n\n- User Login & Access\n- Document Management\n- AI Search\n- AI RAG & Summary\n- Related Slides & Case Studies';
  const svg = generateSvg({
    template: 'hierarchy', theme: 'professional', palette: 'blue', title: 'Core Features',
    data: { nodes: [
      { id: 'root', label: 'Core Features' },
      { id: 'login', label: 'User Login & Access' },
      { id: 'docs', label: 'Document Management' },
      { id: 'search', label: 'AI Search' },
      { id: 'rag', label: 'AI RAG & Summary' },
      { id: 'slides', label: 'Related Slides & Case Studies' }
    ], edges: [
      { source: 'root', target: 'login' }, { source: 'root', target: 'docs' },
      { source: 'root', target: 'search' }, { source: 'root', target: 'rag' }, { source: 'root', target: 'slides' }
    ]
    }
  });
  assert(svg.includes('<svg') && svg.includes('User Login &amp; Access'));
  assert(!svg.includes('Start') && !svg.includes('Process') && !svg.includes('End'));

  const signatures = {
    pdf: value => value.subarray(0, 5).toString() === '%PDF-',
    docx: value => value.subarray(0, 2).toString() === 'PK',
    pptx: value => value.subarray(0, 2).toString() === 'PK',
    xlsx: value => value.subarray(0, 2).toString() === 'PK',
    csv: value => value.toString().includes('Type,Content')
  };
  for (const format of Object.keys(signatures)) {
    const generated = await generateFile(format, answer, 'Core Features');
    assert(generated.buffer.length > 0 && signatures[format](generated.buffer), `${format} signature`);
  }

  const storage = getStorageProvider();
  const key = `org_default/hardening-test-${Date.now()}.txt`;
  const original = Buffer.from('hardening storage round trip', 'utf8');
  await storage.put(original, key, 'text/plain');
  assert(await storage.exists(key));
  const stored = await new Promise((resolve, reject) => {
    const chunks = [];
    storage.getStream(key).then(stream => { stream.on('data', chunk => chunks.push(chunk)); stream.on('end', () => resolve(Buffer.concat(chunks))); stream.on('error', reject); }).catch(reject);
  });
  assert.deepStrictEqual(stored, original);
  await storage.delete(key);
  assert(!(await storage.exists(key)));

  console.log('deterministic hardening checks: PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
