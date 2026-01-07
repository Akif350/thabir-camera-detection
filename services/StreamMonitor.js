const cron = require('node-cron');
const Camera = require('../models/Camera');
const ffmpegManager = require('./FFmpegManager');

class StreamMonitor {
  constructor() {
    this.isRunning = false;
    this.cronJob = null;
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

    // Check every 15 seconds for faster recovery (24/7 streaming guarantee)
    this.cronJob = cron.schedule('*/15 * * * * *', async () => {
      await this.checkAllStreams();
    });

    // Initial check immediately and then every 15 seconds
    // Immediate check ensures streams start right away
    setTimeout(() => {
      this.checkAllStreams();
    }, 2000); // Reduced to 2 seconds for faster startup
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
        
        // Update last checked time
        camera.lastChecked = Date.now();
        
        if (!isRunning && camera.active) {
          console.log(`[Monitor] ⚠️ Stream ${camera.streamName} is not running, restarting immediately...`);
          try {
            // Force restart - ensure 24/7 streaming
            await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
            console.log(`[Monitor] ✅ Stream ${camera.streamName} restarted successfully`);
            // Update status
            camera.streaming = true;
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

      for (const camera of cameras) {
        try {
          console.log(`[Monitor] 🔄 Restoring stream: ${camera.streamName}`);
          // Check if already running
          if (!ffmpegManager.isStreamRunning(camera.streamName)) {
            await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
            console.log(`[Monitor] ✅ Restored stream: ${camera.streamName}`);
          } else {
            console.log(`[Monitor] ℹ️ Stream ${camera.streamName} already running`);
          }
          // Small delay between starts to avoid overwhelming the system
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`[Monitor] ❌ Failed to restore ${camera.streamName}:`, error.message);
          console.log(`[Monitor] Will retry in monitor cycle`);
        }
      }

      console.log('[Monitor] Stream restoration completed');
    } catch (error) {
      console.error('[Monitor] Error restoring streams:', error.message);
    }
  }
}

module.exports = new StreamMonitor();

