require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initPool, getPool, query, closePool } = require('./lib/db');
const { getEmbeddingProvider } = require('./lib/embeddings');
const { startWorker, stopWorker } = require('./lib/jobs/worker');
const jobQueue = require('./lib/jobs/queue');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');
const { requireAdmin, requireUser } = require('./middleware/auth');

// Initialize database pool
initPool();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const status = {
    application: 'healthy',
    database: 'unhealthy',
    pgvector: 'unhealthy',
    storage: 'healthy',
    embeddings: 'unhealthy',
    llm: 'healthy',
    worker: 'healthy',
    queue: 'unhealthy'
  };

  // Check DB and pgvector
  const pool = getPool();
  if (pool) {
    try {
      await query('SELECT 1');
      status.database = 'healthy';
      
      const vectorRes = await query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
      if (vectorRes.rowCount > 0) {
        status.pgvector = 'healthy';
      }
      
      if (jobQueue.initialized) {
        status.queue = 'healthy';
      }
    } catch (e) {
      status.database = 'unhealthy';
    }
  } else {
    status.database = 'not_configured';
    status.pgvector = 'not_configured';
    status.queue = 'not_configured';
  }

  // Check Embeddings
  const embedProvider = getEmbeddingProvider();
  if (embedProvider.isConfigured()) {
    if (embedProvider.isReady && embedProvider.isReady()) {
      status.embeddings = 'healthy';
      const embInfo = embedProvider.getEmbeddingInfo();
      status.embeddingModel = embInfo.model;
      status.embeddingDimensions = embInfo.dimensions;
    } else {
      status.embeddings = 'configured';
    }
  } else {
    status.embeddings = 'not_configured';
  }

  res.json(status);
});

// ---------- Auth API (public) ----------
app.use('/api', authRoutes);

// ---------- Admin API (upload/list/delete — admin session required) ----------
app.use('/api/admin', adminRoutes);

// ---------- Chat API (ask/generate/download — user or admin session required) ----------
app.use('/api/chat', chatRoutes);

// ---------- Gate the two app pages before serving static files ----------
app.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin', (req, res) => res.redirect('/admin.html'));

app.get('/chat.html', requireUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});
app.get('/chat', (req, res) => res.redirect('/chat.html'));

app.get('/login', (req, res) => res.redirect('/login.html'));

app.get('/', (req, res) => {
  if (req.session && req.session.role === 'admin') return res.redirect('/admin.html');
  if (req.session && req.session.role === 'user') return res.redirect('/chat.html');
  res.redirect('/login.html');
});

// Everything else (login.html, css, js, images) is public static content.
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  const { GROQ_MODEL, FALLBACK_MODELS } = require('./lib/claude');
  console.log(`Knowledge Studio running at http://localhost:${PORT}`);
  console.log(`Groq primary model: ${GROQ_MODEL}`);
  console.log(`Groq fallback models: ${FALLBACK_MODELS.join(', ')}`);
  const embedProvider = getEmbeddingProvider();
  if (embedProvider.isConfigured()) {
    console.log(`Embedding provider: ${embedProvider.getEmbeddingInfo().provider} (${embedProvider.getEmbeddingInfo().model})`);
    
    // Start background worker since we have DB and embeddings
    if (getPool()) {
      jobQueue.init().then(() => {
        startWorker();
      }).catch(err => {
        console.error('Failed to initialize job queue', err);
      });
    }
  } else {
    console.log(`Embeddings: NOT CONFIGURED`);
  }
});

// Graceful Shutdown Handler
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
  
  // Stop accepting HTTP requests
  server.close(async () => {
    console.log('[Server] HTTP server closed.');
    
    // Stop background workers
    stopWorker();
    
    // Allow brief time for active queries to finish, then close DB
    setTimeout(async () => {
      await closePool();
      console.log('[Server] Graceful shutdown complete.');
      process.exit(0);
    }, 2000); // 2 second grace period
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
