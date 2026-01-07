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

    // Check every 15 seconds
    this.cronJob = cron.schedule('*/15 * * * * *', async () => {
      await this.checkAllStreams();
    });

    // Initial check after 5 seconds (give time for manual starts to stabilize)
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
      
      console.log(`[Monitor] Checking ${cameras.length} active cameras...`);
      
      for (const camera of cameras) {
        const isRunning = ffmpegManager.isStreamRunning(camera.streamName);
        const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
        
        // Update last checked time
        camera.lastChecked = Date.now();
        
        if (!isRunning && camera.active) {
          // Stream should be running but isn't
          console.log(`[Monitor] ⚠️ Stream ${camera.streamName} is not running, restarting immediately...`);
          console.log(`[Monitor] Camera DB state - streaming: ${camera.streaming}, processId: ${camera.processId}`);
          
          try {
            // Force restart
            await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
            console.log(`[Monitor] ✅ Stream ${camera.streamName} restart initiated`);
            
            // Wait a bit for stream to stabilize before updating
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Re-check if stream is actually running now
            const isNowRunning = ffmpegManager.isStreamRunning(camera.streamName);
            const newProcessInfo = ffmpegManager.getProcessInfo(camera.streamName);
            
            if (isNowRunning && newProcessInfo) {
              camera.streaming = true;
              camera.processId = newProcessInfo.process.pid;
              console.log(`[Monitor] ✅ Stream ${camera.streamName} verified running with PID ${newProcessInfo.process.pid}`);
            } else {
              camera.streaming = false;
              camera.processId = null;
              console.log(`[Monitor] ⚠️ Stream ${camera.streamName} restart initiated but not yet verified`);
            }
          } catch (error) {
            console.error(`[Monitor] ❌ Failed to restart ${camera.streamName}:`, error.message);
            camera.streaming = false;
            camera.processId = null;
          }
        } else if (isRunning && processInfo) {
          // Stream is running - verify and update status
          if (!camera.streaming || camera.processId !== processInfo.process.pid) {
            console.log(`[Monitor] 🔄 Updating status for ${camera.streamName} - was: streaming=${camera.streaming}, processId=${camera.processId}`);
            camera.streaming = true;
            camera.processId = processInfo.process.pid;
            console.log(`[Monitor] ✅ Status updated - now: streaming=true, processId=${processInfo.process.pid}`);
          }
        } else if (!isRunning && !camera.active) {
          // Camera is inactive and stream is not running - expected state
          if (camera.streaming) {
            camera.streaming = false;
            camera.processId = null;
            console.log(`[Monitor] 🔄 Updating inactive camera ${camera.streamName} status to not streaming`);
          }
        }
        
        await camera.save();
      }
      
      console.log(`[Monitor] Check completed. Active streams: ${ffmpegManager.getActiveStreams().length}`);
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
            console.log(`[Monitor] ✅ Restore initiated for: ${camera.streamName}`);
            
            // Wait for stream to stabilize
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Verify
            const isRunning = ffmpegManager.isStreamRunning(camera.streamName);
            const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
            
            if (isRunning && processInfo) {
              camera.streaming = true;
              camera.processId = processInfo.process.pid;
              await camera.save();
              console.log(`[Monitor] ✅ Stream ${camera.streamName} verified running with PID ${processInfo.process.pid}`);
            } else {
              console.log(`[Monitor] ⚠️ Stream ${camera.streamName} initiated but not yet verified`);
            }
          } else {
            console.log(`[Monitor] ℹ️ Stream ${camera.streamName} already running`);
            const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
            if (processInfo) {
              camera.streaming = true;
              camera.processId = processInfo.process.pid;
              await camera.save();
            }
          }
          
          // Small delay between starts
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`[Monitor] ❌ Failed to restore ${camera.streamName}:`, error.message);
          camera.streaming = false;
          camera.processId = null;
          await camera.save();
        }
      }

      console.log('[Monitor] Stream restoration completed');
    } catch (error) {
      console.error('[Monitor] Error restoring streams:', error.message);
    }
  }

  /**
   * Force refresh status for all cameras from actual process state
   */
  async forceRefreshStatus() {
    console.log('[Monitor] Force refreshing camera statuses...');
    try {
      const cameras = await Camera.find({ active: true });
      
      for (const camera of cameras) {
        const isRunning = ffmpegManager.isStreamRunning(camera.streamName);
        const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
        
        if (isRunning && processInfo) {
          camera.streaming = true;
          camera.processId = processInfo.process.pid;
        } else {
          camera.streaming = false;
          camera.processId = null;
        }
        
        camera.lastChecked = Date.now();
        await camera.save();
        
        console.log(`[Monitor] Updated ${camera.streamName}: streaming=${camera.streaming}, PID=${camera.processId}`);
      }
      
      console.log('[Monitor] Status refresh completed');
    } catch (error) {
      console.error('[Monitor] Error refreshing status:', error.message);
    }
  }
}

module.exports = new StreamMonitor();