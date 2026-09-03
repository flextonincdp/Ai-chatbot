const http = require('http');
const crypto = require('crypto');

const PORT = 3000;
let cookie = '';
const conversationId = crypto.randomUUID();

const tests = [
  { q: "Prepare this for my manager.", expected: ['docx', 'pptx'] },
  { q: "I need something I can print and share.", expected: ['pdf'] },
  { q: "I need something I can edit.", expected: ['docx'] },
  { q: "I need something I can work with and filter.", expected: ['xlsx'] },
  { q: "Put the numbers into a spreadsheet.", expected: ['xlsx'] },
  { q: "Turn this into something I can present.", expected: ['pptx'] },
  { q: "Map this out.", expected: ['svg'] },
  { q: "Show me how this works.", expected: ['none', 'svg'] },
  { q: "Make that professional.", expected: ['docx', 'pptx', 'pdf', 'xlsx', 'svg'] },
  { q: "Convert that to Excel.", expected: ['xlsx'] },
  { q: "Now make it a PDF.", expected: ['pdf'] },
  { q: "Now show it as a diagram.", expected: ['svg'] }
];

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        ...headers
      }
    };
    const req = http.request(opts, (res) => {
      let data = [];
      res.on('data', c => data.push(c));
      res.on('end', () => {
        const bodyStr = Buffer.concat(data).toString();
        if (res.headers['set-cookie']) {
          cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        }
        let parsed = bodyStr;
        try { parsed = JSON.parse(bodyStr); } catch(e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, rawBody: Buffer.concat(data) });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function checkSignature(format, buffer) {
  const sig2 = buffer.toString('utf8', 0, 2);
  const sig5 = buffer.toString('utf8', 0, 5);
  if (format === 'pdf' && sig5 === '%PDF-') return true;
  if (['docx', 'pptx', 'xlsx', 'ods'].includes(format) && sig2 === 'PK') return true;
  if (format === 'svg' && buffer.toString('utf8').includes('<svg')) return true;
  if (format === 'csv' || format === 'txt' || format === 'md' || format === 'tsv' || format === 'rtf' || format === 'json' || format === 'html') return true; // generic text
  return false;
}

async function runTests() {
  console.log('Logging in...');
  const loginRes = await request('POST', '/api/login', { role: 'user', code: 'user123' });
  if (loginRes.status !== 200) {
    console.error('Login failed', loginRes.body);
    return;
  }
  
  let passed = 0;
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    console.log(`\n======================================================`);
    console.log(`TEST ${i+1}: "${t.q}"`);
    console.log(`EXPECTED FORMAT: ${t.expected.join(' OR ')}`);
    
    const askRes = await request('POST', '/api/chat/ask', {
      query: t.q,
      conversationId,
      stream: false
    });

    if (askRes.status !== 200) {
      console.log(`[FAIL] API returned ${askRes.status}:`, askRes.body);
      continue;
    }

    const { answer, document } = askRes.body;
    let actualFormat = document ? document.format : 'none';
    let dlUrl = document ? document.downloadUrl : null;
    
    console.log(`ACTUAL FORMAT: ${actualFormat}`);
    
    if (t.expected.includes(actualFormat) || (actualFormat !== 'none' && t.expected.includes('any'))) {
      if (actualFormat !== 'none' && dlUrl) {
         // Download and verify
         const dlRes = await request('GET', dlUrl);
         if (dlRes.status !== 200) {
            console.log(`[FAIL] Download returned ${dlRes.status}`);
            continue;
         }
         const mime = dlRes.headers['content-type'];
         const validSig = checkSignature(actualFormat, dlRes.rawBody);
         console.log(`MIME: ${mime} | Sig OK: ${validSig} | Size: ${dlRes.rawBody.length}`);
         
         if (validSig) {
           console.log(`[PASS]`);
           passed++;
         } else {
           console.log(`[FAIL] Invalid signature for ${actualFormat}`);
         }
      } else {
         console.log(`[PASS]`);
         passed++;
      }
    } else {
      console.log(`[FAIL] Expected ${t.expected.join('/')} but got ${actualFormat}`);
    }
    
    // Wait 4 seconds between tests to avoid rate limits
    await new Promise(r => setTimeout(r, 4000));
  }
  
  console.log(`\nRESULT: ${passed}/${tests.length} tests passed.`);
}

runTests().catch(console.error);
