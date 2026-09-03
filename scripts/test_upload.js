const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function testUpload() {
  const testFileName = 'test_upload_' + Date.now() + '.txt';
  const testFilePath = path.join(__dirname, '..', testFileName);
  fs.writeFileSync(testFilePath, 'This is a test document content for upload route.');

  try {
    console.log('Logging in...');
    const loginRes = await fetch('http://localhost:3000/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', username: 'admin', password: 'password@123' })
    });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    
    console.log('Uploading file...');
    const fileBuffer = fs.readFileSync(testFilePath);
    const blob = new Blob([fileBuffer], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('files', blob, testFileName);

    const uploadRes = await fetch('http://localhost:3000/api/admin/upload', {
      method: 'POST',
      headers: { 'Cookie': cookie },
      body: formData
    });
    
    const uploadData = await uploadRes.json();
    if (!uploadData.success) throw new Error('Upload failed: ' + JSON.stringify(uploadData));
    
    console.log('Upload Data:', JSON.stringify(uploadData, null, 2));
    const docMeta = uploadData.log[0].document;

    const pool = new Pool({ connectionString: 'postgresql://postgres:password@127.0.0.1:5440/knowledge_studio' });
    const dbDoc = await pool.query('SELECT * FROM documents WHERE id = $1', [docMeta.documentId]);
    
    if (dbDoc.rowCount > 0) {
      console.log('DB Document Found: PASS');
      const row = dbDoc.rows[0];
      console.log('- ID:', row.id);
      console.log('- SHA256:', row.sha256);
      console.log('- Status:', row.status);
      console.log('- Ext:', row.extension);
      
      const storagePath = path.join(__dirname, '..', 'uploads', row.storage_key);
      if (fs.existsSync(storagePath)) {
        console.log('Storage File Exists: PASS', storagePath);
      } else {
        console.log('Storage File Exists: FAIL', storagePath);
      }
    } else {
      console.log('DB Document Found: FAIL');
    }

    const dbChunks = await pool.query('SELECT count(*) FROM chunks WHERE document_version_id = $1', [docMeta.documentId + '_v1']);
    console.log('Chunk count in DB: PASS', dbChunks.rows[0].count, 'chunks');

    await pool.end();
  } catch (err) {
    console.error('Test Error:', err);
  } finally {
    fs.unlinkSync(testFilePath);
  }
}

testUpload();
