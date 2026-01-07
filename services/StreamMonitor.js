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

    // Check every 30 seconds
    this.cronJob = cron.schedule('*/30 * * * * *', async () => {
      await this.checkAllStreams();
    });

    // Initial check after 5 seconds
    setTimeout(() => {
      this.checkAllStreams();
    }, 5000);
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
          console.log(`[Monitor] Stream ${camera.streamName} is not running, restarting...`);
          try {
            await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
            console.log(`[Monitor] Stream ${camera.streamName} restarted successfully`);
          } catch (error) {
            console.error(`[Monitor] Failed to restart ${camera.streamName}:`, error.message);
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
          console.log(`[Monitor] Restoring stream: ${camera.streamName}`);
          await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
          // Small delay between starts
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`[Monitor] Failed to restore ${camera.streamName}:`, error.message);
        }
      }

      console.log('[Monitor] Stream restoration completed');
    } catch (error) {
      console.error('[Monitor] Error restoring streams:', error.message);
    }
  }
}

module.exports = new StreamMonitor();

