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

// Swagger UI setup - Express handles arrays automatically
app.use('/api-docs', swaggerUi.serve);
app.get('/api-docs', swaggerUi.setup(swaggerSpec, swaggerOptions));

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Thabir Streaming Server API',
    version: '1.0.0',
    status: 'running',
    baseUrl: config.baseUrl,
    documentation: `${config.baseUrl}/api-docs`,
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
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeStreams: streamMonitor.isRunning ? ffmpegManager.getActiveStreams().length : 0
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

// Connect to MongoDB
console.log('[MongoDB] Attempting to connect...');
console.log('[MongoDB] MONGODB_URI from env:', process.env.MONGODB_URI ? 'SET' : 'NOT SET');
console.log('[MongoDB] Using URI:', config.mongodbUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')); // Hide password in logs

mongoose.connect(config.mongodbUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('[MongoDB] ✅ Connected successfully to Atlas');
  console.log(`[MongoDB] Database: ${mongoose.connection.name}`);
  
  // Start the server - bind to 0.0.0.0 for Railway (accept external connections)
  const host = '0.0.0.0'; // Listen on all interfaces for Railway
  app.listen(config.port, host, () => {
    console.log(`[Server] Running on ${host}:${config.port}`);
    console.log(`[Server] Environment: ${config.nodeEnv}`);
    console.log(`[MediaMTX] Host: ${config.mediamtx.host}:${config.mediamtx.rtspPort}`);
    
    // Restore all active streams on startup - CRITICAL for 24/7 streaming
    streamMonitor.restoreStreams().then(() => {
      // Start monitoring after restoration - ensures streams never stop
      streamMonitor.start();
      console.log('[Monitor] ✅ Stream monitoring started - 24/7 streaming enabled');
      console.log('[Monitor] Streams will auto-restart every 15 seconds if stopped');
    }).catch((error) => {
      console.error('[Monitor] Error starting monitor:', error);
      // Still start monitoring even if restore fails
      streamMonitor.start();
    });
  });
})
.catch((error) => {
  console.error('[MongoDB] Connection error:', error);
  process.exit(1);
});

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
  console.error('[MongoDB] Error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB] Disconnected');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, shutting down...');
  await streamMonitor.stop();
  await require('./services/FFmpegManager').stopAll();
  mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received, shutting down...');
  await streamMonitor.stop();
  await require('./services/FFmpegManager').stopAll();
  mongoose.connection.close();
  process.exit(0);
});

