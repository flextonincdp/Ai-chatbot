/**
 * Load Test Script for Knowledge Studio
 * Verifies upload concurrency, worker queues, and chat concurrency.
 */
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}/api`;

async function getCookie() {
  const loginRes = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin', username: 'admin', password: 'password@123' })
  });
  return loginRes.headers.get('set-cookie').split(';')[0];
}

async function testConcurrentUploads(cookie) {
  console.log('--- Testing Document Upload Concurrency ---');
  
  // Create dummy test files
  const testFiles = Array.from({ length: 5 }, (_, i) => {
    const p = path.join(__dirname, `scale_test_${i}.txt`);
    fs.writeFileSync(p, `This is scale test document ${i}. It has some unique content to embed. ` + 'hello '.repeat(100));
    return p;
  });

  const uploadPromises = testFiles.map(async (file, idx) => {
    const fileBuffer = fs.readFileSync(file);
    const blob = new Blob([fileBuffer], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('files', blob, `scale_test_${idx}.txt`);

    console.log(`[Upload] Uploading file ${idx}...`);
    const start = Date.now();
    const res = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: { 'Cookie': cookie },
      body: formData
    });
    
    const data = await res.json();
    return { idx, file: `scale_test_${idx}.txt`, time: Date.now() - start, status: res.status, log: data.log };
  });

  const uploadResults = await Promise.all(uploadPromises);
  
  let successCount = 0;
  uploadResults.forEach(r => {
    const logEntry = r.log[0];
    if (r.status === 200 && logEntry && (logEntry.status === 'queued' || logEntry.status === 'duplicate')) {
      successCount++;
    }
  });

  console.log(`[Upload] Result: ${successCount}/5 successfully queued or duplicate`);
  
  // Clean up
  testFiles.forEach(f => {
    try { fs.unlinkSync(f); } catch (e) { /* ignore EBUSY */ }
  });
  return successCount === 5;
}

async function testConcurrentChats(cookie, count = 10) {
  console.log(`\n--- Testing Chat Concurrency (${count} requests) ---`);
  
  const chatPromises = Array.from({ length: count }, async (_, i) => {
    const start = Date.now();
    const res = await fetch(`${BASE_URL}/chat/ask`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Cookie': cookie 
      },
      body: JSON.stringify({ query: `What is scale test document ${i % 5}?` })
    });
    
    return { idx: i, time: Date.now() - start, status: res.status };
  });

  const chatResults = await Promise.all(chatPromises);
  
  let successCount = 0;
  let totalTime = 0;
  let maxTime = 0;

  chatResults.forEach(r => {
    if (r.status === 200) successCount++;
    totalTime += r.time;
    if (r.time > maxTime) maxTime = r.time;
  });

  console.log(`[Chat] Result: ${successCount}/${count} succeeded`);
  console.log(`[Chat] Avg Latency: ${(totalTime / count).toFixed(2)}ms, Max Latency: ${maxTime}ms`);
  
  return successCount === count;
}

async function runTests() {
  console.log('Starting Scale Tests...\n');
  try {
    const cookie = await getCookie();
    if (!cookie) {
      console.error('Failed to get auth cookie');
      process.exit(1);
    }
    
    // Upload test
    const uploadOk = await testConcurrentUploads(cookie);
    
    // Give background workers 5 seconds to process jobs
    console.log('\n[Wait] Waiting 5 seconds for background workers to process jobs...');
    await new Promise(r => setTimeout(r, 5000));

    // Chat tests (5 then 10)
    const chat5Ok = await testConcurrentChats(cookie, 5);
    const chat10Ok = await testConcurrentChats(cookie, 10);

    if (uploadOk && chat5Ok && chat10Ok) {
      console.log('\n✅ ALL LOAD TESTS PASSED');
      process.exit(0);
    } else {
      console.log('\n❌ SOME TESTS FAILED');
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal Test Error:', err);
    process.exit(1);
  }
}

runTests();
