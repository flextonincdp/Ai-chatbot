async function test() {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY || 'YOUR_GROQ_API_KEY_HERE'}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: 'test string',
        model: 'nomic-embed-text-v1_5'
      })
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(err);
  }
}
test();
