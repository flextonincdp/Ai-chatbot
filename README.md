# Knowledge Studio

A small internal web app with two roles:

- **Admin dashboard** (`/admin.html`) — upload `.txt`, `.md`, `.csv`, `.pdf`, `.docx`, `.pptx` files.
  Each file is split into overlapping text chunks and indexed. Admin can also remove files.
- **Employee chatbot** (`/chat.html`) — ask a question. The app finds the most relevant chunks
  from the indexed files and asks the AI to answer **using only those chunks** — never from its
  own general knowledge. Once you confirm the answer looks right, you can export it as a real
  **PDF, Word (.docx), PowerPoint (.pptx), or plain text (.txt)** file. The AI is used a second
  time here too, but only to draft the wording/layout of the export — the facts still come from
  your confirmed answer, not from the model's imagination.

Both roles require logging in first (`/login.html`), so the knowledge base isn't open to
anyone who finds the URL.

## How the "only answer from chunks" part works

`lib/claude.js` builds a strict prompt (`buildGroundedPrompt`) that:
1. Gives the model only the top-matching chunks as context.
2. Tells it not to add any fact that isn't literally in those chunks.
3. Tells it to say so explicitly if the chunks don't contain the answer, instead of guessing.
4. Requires a `(Source: filename)` citation after every factual sentence.

Retrieval itself (`lib/retrieval.js`) is simple keyword/term-frequency matching — no external
vector database needed. It's a good starting point for a small-to-medium knowledge base; if you
outgrow it, swap in real embeddings + a vector store (e.g. `pgvector`, Pinecone, Chroma) behind
the same `retrieveTopChunks()` interface.

## LLM provider: Groq only

This app calls Groq's OpenAI-compatible chat endpoint (`https://api.groq.com/openai/v1/chat/completions`)
in `lib/claude.js`. There is no Anthropic code path at all, so it cannot fall back to it.

1. Get a free key at https://console.groq.com/api-keys — it starts with `gsk_`.
2. In `.env`, set `GROQ_API_KEY=gsk_your_real_key`.
3. Restart the server (`npm start`) — env vars are only read at startup.

On startup the terminal prints something like:

```
Knowledge Studio running at http://localhost:3000
LLM provider: Groq (llama-3.3-70b-versatile)
GROQ_API_KEY loaded: yes (gsk_ab…)
```

If it prints `GROQ_API_KEY loaded: NO`, your `.env` isn't being read (check it's in the project
root, not renamed `.env.example`, and that you restarted the server after editing it). If you get
an error that clearly says "Groq API error: ...", the key itself is invalid/expired — generate a
new one from the Groq console and paste it in.

## Setup

```bash
npm install
cp .env.example .env
# then edit .env:
#   GROQ_API_KEY          - your Groq API key (get one at console.groq.com/api-keys)
#   SESSION_SECRET       - any long random string
#   ADMIN_USERNAME / ADMIN_PASSWORD - the admin login
#   USER_ACCESS_CODE     - the shared code employees use to open the chatbot
npm start
```

Then open `http://localhost:3000` — it redirects to the login page.

## Project layout

```
server.js               Express app: sessions, page gating, mounts the routes below
routes/auth.js           /api/login, /api/logout, /api/whoami
routes/admin.js          /api/admin/upload, /api/admin/kb, /api/admin/kb/:id  (admin only)
routes/chat.js           /api/chat/ask, /api/chat/generate, /api/chat/download/:id (login required)
middleware/auth.js       requireAdmin / requireUser session checks
lib/extractText.js       pulls plain text out of pdf/docx/pptx/txt/md/csv
lib/chunk.js             splits text into overlapping chunks
lib/retrieval.js         keyword-based top-k chunk retrieval
lib/claude.js            Groq API call + the two prompts (grounded answer, export draft)
lib/fileGenerators.js    turns drafted text into a real .txt/.docx/.pptx/.pdf buffer
public/login.html+js     role picker (Employee / Admin) + login form
public/admin.html+js     upload dropzone + indexed file list with delete
public/chat.html+js      ask box, grounded answer, confirm, export & download
public/css/style.css     shared styling
data/kb.json             the knowledge base itself (docs + chunks) — gitignored
uploads/                 temp storage while a file is being processed — files are deleted after indexing
generated/               (unused on disk — generated exports are kept in memory for ~10 min, see routes/chat.js)
```

## Notes on "safety" of the data

- Only an admin session can upload or delete knowledge-base files.
- Only a logged-in session (admin or employee) can query the chatbot or export a document.
- By default (`EXPOSE_CHUNK_TEXT_TO_USERS=false` in `.env`), employees see which **source files**
  were used to answer their question, but not the raw retrieved passages — only the admin
  dashboard shows full indexed content. Set it to `true` if you'd rather show employees the exact
  passages for transparency/debugging.
- Generated export files are held in server memory only long enough to be downloaded once (or
  10 minutes, whichever comes first) — they are not written to disk.
- This is a small-team prototype: admin and employee logins are single shared credentials, not
  per-person accounts, and sessions are stored in memory (they reset if the server restarts). For
  a larger rollout, add a real user table with hashed passwords and a persistent session store
  (e.g. Redis) before deploying.
