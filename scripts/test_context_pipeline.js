// Using native fetch API

const conversation = [
  "explain core feature in case studies",
  "Give me a summary",
  "based on the information i want pdf to download",
  "Create a flow diagram",
  "flow diagram",
  "process flow diagram"
];

async function run() {
  console.log('Logging in...');
  const loginRes = await fetch('http://localhost:3000/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin', username: 'admin', password: 'password@123' })
  });
  
  const cookieHeader = loginRes.headers.get('set-cookie');
  let sessionCookie = '';
  if (cookieHeader) {
     sessionCookie = cookieHeader.split(';')[0];
  }
  
  let conversationId = null;
  console.log('Starting Conversation Context Test...\n');

  for (let i = 0; i < conversation.length; i++) {
    const query = conversation[i];
    console.log(`\n================================`);
    console.log(`STEP ${i+1}: "${query}"`);
    console.log(`================================`);
    
    try {
      const start = Date.now();
      const payload = { query };
      if (conversationId) payload.conversationId = conversationId;
      
      const res = await fetch('http://localhost:3000/api/chat/ask', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Cookie': sessionCookie
        },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) {
        console.error(`HTTP Error: ${res.status} ${res.statusText}`);
        const text = await res.text();
        console.error(`Response body: ${text}`);
        continue;
      }
      
      const data = await res.json();
      
      conversationId = data.conversationId;
      const intent = data.intent;
      
      console.log(`Response Time: ${Date.now() - start}ms`);
      console.log(`Intent JSON:`, JSON.stringify(intent));
      console.log(`Answer Snippet:`, (data.answer || '').substring(0, 150).replace(/\n/g, ' '));
      
      if (data.sources) {
        console.log(`Sources: ${data.sources.join(', ')}`);
      }
      
      if (data.diagram) {
        console.log(`Diagram Generated: ${data.diagram.filename}`);
      }

    } catch (e) {
      console.error(`Error on step ${i+1}:`, e.response?.data || e.message);
    }
  }
}

run();
