const cron = require('node-cron');
const Camera = require('../models/Camera');
const ffmpegManager = require('./FFmpegManager');

class StreamMonitor {
  constructor() {
    this.isRunning = false;
    this.cronJob = null;
    this.isInitialCheckComplete = false;
  }

  /**
   * Start monitoring all active cameras
   */
  start() {
    if (this.isRunning) {
      console.log('[Monitor] Already running');
      return;
    }

    this.isRunning = true;
    console.log('[Monitor] Starting stream monitor...');

    // Check every 30 seconds (increased from 15 to reduce interference)
    this.cronJob = cron.schedule('*/30 * * * * *', async () => {
      // Only run regular checks after initial check is complete
      if (this.isInitialCheckComplete) {
        await this.checkAllStreams();
      }
    });

    // Initial check after a delay to let the system stabilize
    setTimeout(async () => {
      await this.checkAllStreams();
      this.isInitialCheckComplete = true;
      console.log('[Monitor] Initial check complete, now monitoring every 30 seconds');
    }, 5000); // Wait 5 seconds before first check
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.isRunning = false;
    console.log('[Monitor] Stopped');
  }

  /**
   * Check all active cameras and restart if needed
   */
  async checkAllStreams() {
    try {
      const cameras = await Camera.find({ active: true });
      
      for (const camera of cameras) {
        const isRunning = ffmpegManager.isStreamRunning(camera.streamName);
        const isStarting = ffmpegManager.isStreamStarting(camera.streamName);
        
        // Update last checked time
        camera.lastChecked = Date.now();
        
        // Skip if stream is currently starting up
        if (isStarting) {
          console.log(`[Monitor] ⏳ Stream ${camera.streamName} is starting, skipping check`);
          continue;
        }
        
        if (!isRunning && camera.active) {
          console.log(`[Monitor] ⚠️ Stream ${camera.streamName} is not running, restarting...`);
          try {
            // Verify stream is actually not available before restarting
            const isAvailable = await ffmpegManager.checkStreamAvailability(camera.streamName);
            
            if (!isAvailable) {
              await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
              console.log(`[Monitor] ✅ Stream ${camera.streamName} restart initiated`);
              camera.streaming = true;
            } else {
              console.log(`[Monitor] ℹ️ Stream ${camera.streamName} is available despite process not found`);
              camera.streaming = true;
            }
            
            camera.lastChecked = Date.now();
          } catch (error) {
            console.error(`[Monitor] ❌ Failed to restart ${camera.streamName}:`, error.message);
            console.log(`[Monitor] Will retry in next check cycle`);
            camera.streaming = false;
            camera.lastChecked = Date.now();
          }
        } else if (isRunning) {
          // Update streaming status
          const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
          if (processInfo && processInfo.process.pid) {
            camera.streaming = true;
            camera.processId = processInfo.process.pid;
          }
        }
        
        await camera.save();
      }
    } catch (error) {
      console.error('[Monitor] Error checking streams:', error.message);
    }
  }

  /**
   * Restore all active streams on server start
   */
  async restoreStreams() {
    console.log('[Monitor] Restoring all active streams...');
    try {
      const cameras = await Camera.find({ active: true });
      console.log(`[Monitor] Found ${cameras.length} active cameras to restore`);

      // Process cameras sequentially to avoid overwhelming the system
      for (const camera of cameras) {
        try {
          console.log(`[Monitor] 🔄 Restoring stream: ${camera.streamName}`);
          
          // Check if already running
          if (!ffmpegManager.isStreamRunning(camera.streamName)) {
            await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
            console.log(`[Monitor] ✅ Stream restoration started: ${camera.streamName}`);
            
            // Longer delay between starts to ensure each stream has time to initialize
            await new Promise(resolve => setTimeout(resolve, 3000));
          } else {
            console.log(`[Monitor] ℹ️ Stream ${camera.streamName} already running`);
          }
        } catch (error) {
          console.error(`[Monitor] ❌ Failed to restore ${camera.streamName}:`, error.message);
          console.log(`[Monitor] Will retry in monitor cycle`);
          
          // Continue with next camera even if this one failed
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      console.log('[Monitor] Stream restoration completed');
    } catch (error) {
      console.error('[Monitor] Error restoring streams:', error.message);
    }
  }
}

module.exports = new StreamMonitor();