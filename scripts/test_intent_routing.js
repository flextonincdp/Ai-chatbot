// Test intent routing logic for format detection and insufficient info logic
const http = require('http');
const fs = require('fs');

const BASE = 'http://localhost:3000';
let sessionCookie = null;

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

    if (sessionCookie) options.headers['Cookie'] = sessionCookie;

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
        if (res.headers['set-cookie']) {
          sessionCookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
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
  const res = await request('POST', '/api/login', { role: 'admin', username: 'admin', password: 'password@123' });
  if (res.status !== 200) {
    const res2 = await request('POST', '/api/login', { role: 'user', code: 'user123' });
    if (res2.status !== 200) throw new Error('Login failed');
  }
}

const tests = [
  { query: "Based on the information generate professional document to download", expectedFormat: "docx" },
  { query: "Based on the information, create a professional PDF report.", expectedFormat: "pdf" },
  { query: "Create a professional PowerPoint presentation based on the information.", expectedFormat: "pptx" },
  { query: "Create a professional flow diagram from the information.", expectedFormat: "svg" },
  { query: "Show the system architecture.", expectedFormat: "svg" },
  { query: "Show the process.", expectedFormat: "svg" },
  { query: "Create a workflow.", expectedFormat: "svg" },
  { query: "Create a timeline.", expectedFormat: "svg" },
];

let lastConversationId = null;

async function runTest(t, isFollowup = false) {
  const res = await request('POST', '/api/chat/ask', {
    query: t.query,
    conversationId: isFollowup ? lastConversationId : undefined
  });
  
  if (res.status !== 200) return { passed: false, result: `HTTP ${res.status}` };
  
  const data = JSON.parse(res.text);
  if (!isFollowup) {
    lastConversationId = data.conversationId;
  }
  
  const intent = data.intent || {};
  const format = intent.requestedFormat;
  
  // Also verify it didn't reject the prompt
  const hasError = data.answer && data.answer.includes("The uploaded documents don't contain information");
  
  let validExt = false;
  let hasArtifact = false;
  
  if (format === 'svg') {
    hasArtifact = !!data.diagram;
    validExt = data.diagram && data.diagram.filename.endsWith('.svg');
  } else if (['docx', 'pdf', 'pptx'].includes(format)) {
    hasArtifact = !!data.document;
    validExt = data.document && data.document.filename.endsWith('.' + format);
  }
  
  const passed = format === t.expectedFormat && !hasError && hasArtifact && validExt;
  
  if (!passed) {
    console.log(`Failed on query: "${t.query}"`);
    console.log(`Intent JSON:`, JSON.stringify(intent, null, 2));
    console.log(`Answer:`, data.answer);
  }
  
  return { passed, format, hasError, hasArtifact, validExt };
}

async function main() {
  await login();
  console.log('| User Request | Expected | Actual Format | Artifact Created | No Insufficient Info Error | PASS |');
  console.log('|---|---|---|---|---|---|');
  
  for (const t of tests) {
    const res = await runTest(t);
    console.log(`| ${t.query} | ${t.expectedFormat} | ${res.format} | ${res.hasArtifact} | ${!res.hasError} | ${res.passed ? 'PASS' : 'FAIL'} |`);
  }
  
  // Followups
  const followups = [
    { query: "Convert this document into PDF.", expectedFormat: "pdf" },
    { query: "Convert this into DOCX.", expectedFormat: "docx" },
    { query: "Convert this into PPT.", expectedFormat: "pptx" }
  ];
  
  for (const t of followups) {
    const res = await runTest(t, true); // true = pass last conversationId
    console.log(`| ${t.query} | ${t.expectedFormat} | ${res.format} | ${res.hasArtifact} | ${!res.hasError} | ${res.passed ? 'PASS' : 'FAIL'} |`);
  }
}

main().catch(e => console.error(e));
