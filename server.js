const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
const config = require('./config');
const cameraRoutes = require('./routes/camera');
const streamMonitor = require('./services/StreamMonitor');
const ffmpegManager = require('./services/FFmpegManager');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Swagger Documentation
const swaggerOptions = {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Thabir Streaming API Documentation'
};

// Swagger UI setup
app.use('/api-docs', swaggerUi.serve);
app.get('/api-docs', swaggerUi.setup(swaggerSpec, swaggerOptions));

// Simple local UI
app.use('/ui', express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Thabir Streaming Server API',
    version: '1.0.0',
    status: 'running',
    baseUrl: config.baseUrl,
    documentation: `${config.baseUrl}/api-docs`,
    ui: `${config.baseUrl}/ui`,
    health: `${config.baseUrl}/health`,
    api: {
      addCamera: `${config.baseUrl}/api/camera/add`,
      listCameras: `${config.baseUrl}/api/camera/list`
    }
  });
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Check server health and get active stream count
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 activeStreams:
 *                   type: integer
 *                   example: 3
 */
app.get('/health', (req, res) => {
  const activeStreams = ffmpegManager.getActiveStreams();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeStreams: activeStreams.length,
    streams: activeStreams,
    monitoring: streamMonitor.isRunning
  });
});

app.use('/api/camera', cameraRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: config.nodeEnv === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Connect to MongoDB and start server
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 THABIR STREAMING SERVER STARTING...');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('[MongoDB] MONGODB_URI:', process.env.MONGODB_URI ? '✅ SET' : '❌ NOT SET');

const host = '0.0.0.0'; // Listen on all interfaces
const disableMongo =
  String(process.env.DISABLE_MONGODB || '').toLowerCase() === 'true' ||
  String(process.env.SKIP_MONGODB || '').toLowerCase() === 'true';

async function startServer({ mongoConnected }) {
  const requestedPort = Number(process.env.PORT || config.port || 9001);
  const maxAttempts = 20;

  async function listenWithFallback(startPort) {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;

      // eslint-disable-next-line no-await-in-loop
      const server = await new Promise((resolve, reject) => {
        const s = app.listen(port, host, () => resolve(s));
        s.on('error', reject);
      }).catch((err) => {
        if (err && err.code === 'EADDRINUSE') return null;
        throw err;
      });

      if (!server) continue;

      // Keep runtime config accurate for docs/links
      config.port = port;
      if (!process.env.BASE_URL && config.nodeEnv !== 'production') {
        config.baseUrl = `http://localhost:${port}`;
      }

      return { server, port };
    }

    throw Object.assign(new Error(`No free port found in range ${startPort}-${startPort + maxAttempts - 1}`), {
      code: 'EADDRINUSE'
    });
  }

  const { port } = await listenWithFallback(requestedPort);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ SERVER RUNNING`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 Host: ${host}:${port}`);
  console.log(`📦 Environment: ${config.nodeEnv}`);
  console.log(`🗄️ MongoDB: ${mongoConnected ? 'connected' : 'not connected'}`);
  console.log(`📹 MediaMTX: ${config.mediamtx.host}:${config.mediamtx.rtspPort}`);
  console.log(`📚 API Docs: ${config.baseUrl}/api-docs`);
  console.log(`💚 Health: ${config.baseUrl}/health`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    if (!mongoConnected) {
      console.log('[Server] ℹ️ Skipping stream restore/monitor (MongoDB not connected).');
      return;
    }

    // CRITICAL: Restore all active streams on startup
    console.log('[Server] 🔄 Initiating stream restoration...\n');
    await streamMonitor.restoreStreams();

    // Start monitoring - this ensures 24/7 streaming
    console.log('\n[Server] 🔄 Starting stream monitoring...');
    streamMonitor.start();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ ALL SYSTEMS READY - 24/7 STREAMING ENABLED');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📺 Active cameras will stream continuously');
    console.log('🔄 Auto-restart every 15 seconds if streams stop');
    console.log('🔌 Streams restore automatically on server restart');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    console.error('[Server] ❌ Error during startup:', error.message);
  }
}

if (disableMongo) {
  console.log('[MongoDB] ⚠️ Disabled via env (DISABLE_MONGODB/SKIP_MONGODB=true).');
  startServer({ mongoConnected: false });
} else {
  console.log('[MongoDB] Attempting to connect...');
  mongoose
    .connect(config.mongodbUri, {})
    .then(async () => {
      console.log('[MongoDB] ✅ Connected successfully');
      console.log(`[MongoDB] Database: ${mongoose.connection.name}`);
      await startServer({ mongoConnected: true });
    })
    .catch((err) => {
      console.error('[MongoDB] ❌ Connection failed:', err.message);
      console.log('[MongoDB] ⚠️ Continuing without MongoDB (set DISABLE_MONGODB=true to silence).');
      startServer({ mongoConnected: false });
    });
}

// ============================================
// GRACEFUL SHUTDOWN HANDLERS
// ============================================
// These handlers ensure all video streams stop when system shuts down
// Works on Windows, Linux, and macOS

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('[Shutdown] Already shutting down, forcing exit...');
    process.exit(1);
    return;
  }

  isShuttingDown = true;
  console.log(`\n[Shutdown] ════════════════════════════════════════════════════`);
  console.log(`[Shutdown] ${signal} received - Initiating graceful shutdown...`);
  console.log(`[Shutdown] ════════════════════════════════════════════════════\n`);

  try {
    // Stop stream monitoring first
    console.log('[Shutdown] 🛑 Stopping stream monitor...');
    streamMonitor.stop();

    // Stop all video streams - this will stop FFmpeg processes
    console.log('[Shutdown] 🛑 Stopping all video streams...');
    await ffmpegManager.stopAll();

    const mongoConnected = mongoose.connection?.readyState === 1;
    if (!mongoConnected) {
      console.log('[Shutdown] ℹ️ MongoDB not connected - skipping DB updates/close.');
    } else {
      // Update database - mark all cameras as not streaming
      console.log('[Shutdown] 📝 Updating database - marking all streams as stopped...');
      const Camera = require('./models/Camera');
      await Camera.updateMany(
        { streaming: true },
        {
          streaming: false,
          processId: null,
          lastChecked: Date.now()
        }
      );
      console.log('[Shutdown] ✅ Database updated - all streams marked as stopped');

      // Close MongoDB connection
      console.log('[Shutdown] 🔌 Closing MongoDB connection...');
      await mongoose.connection.close();
      console.log('[Shutdown] ✅ MongoDB connection closed');
    }

    console.log('\n[Shutdown] ════════════════════════════════════════════════════');
    console.log('[Shutdown] ✅ GRACEFUL SHUTDOWN COMPLETE');
    console.log('[Shutdown] ✅ All video streams stopped on all devices');
    console.log('[Shutdown] ════════════════════════════════════════════════════\n');
    
    process.exit(0);
  } catch (error) {
    console.error('[Shutdown] ❌ Error during shutdown:', error);
    process.exit(1);
  }
}

// Standard shutdown signals (Linux, macOS, Windows with proper signal handling)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Windows-specific shutdown handlers
// Windows doesn't always send SIGTERM/SIGINT on shutdown, so we need these
process.on('beforeExit', async (code) => {
  if (!isShuttingDown && code === 0) {
    console.log('[Shutdown] beforeExit event received');
    await gracefulShutdown('beforeExit');
  }
});

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', async (error) => {
  console.error('[Shutdown] ❌ Uncaught Exception:', error);
  await gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[Shutdown] ❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't shutdown on unhandled rejection, just log it
  // await gracefulShutdown('unhandledRejection');
});