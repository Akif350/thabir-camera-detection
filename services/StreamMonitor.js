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

    // Initial check after 20 seconds (give time for restore to complete)
    setTimeout(() => {
      console.log('[Monitor] Running initial health check...');
      this.checkAllStreams();
    }, 20000);
    
    console.log('[Monitor] ✅ Monitoring scheduled - checking every 15 seconds');
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
      
      if (cameras.length === 0) {
        console.log(`[Monitor] No active cameras found`);
        return;
      }
      
      console.log(`[Monitor] 🔍 Checking ${cameras.length} active cameras...`);
      
      let runningCount = 0;
      let restartedCount = 0;
      
      for (const camera of cameras) {
        const isRunning = ffmpegManager.isStreamRunning(camera.streamName);
        const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
        
        // Update last checked time
        camera.lastChecked = Date.now();
        
        if (!isRunning && camera.active) {
          // Stream should be running but isn't - RESTART IMMEDIATELY
          console.log(`[Monitor] ⚠️ Stream ${camera.streamName} is DOWN - restarting immediately...`);
          console.log(`[Monitor] Camera DB state - streaming: ${camera.streaming}, processId: ${camera.processId}`);
          
          try {
            // Force restart
            await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
            console.log(`[Monitor] ✅ Stream ${camera.streamName} restart initiated`);
            restartedCount++;
            
            // Wait for stream to stabilize
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Re-check if stream is actually running now
            const isNowRunning = ffmpegManager.isStreamRunning(camera.streamName);
            const newProcessInfo = ffmpegManager.getProcessInfo(camera.streamName);
            
            if (isNowRunning && newProcessInfo) {
              camera.streaming = true;
              camera.processId = newProcessInfo.process.pid;
              runningCount++;
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
          runningCount++;
          if (!camera.streaming || camera.processId !== processInfo.process.pid) {
            console.log(`[Monitor] 🔄 Updating status for ${camera.streamName}`);
            console.log(`[Monitor]    Was: streaming=${camera.streaming}, processId=${camera.processId}`);
            camera.streaming = true;
            camera.processId = processInfo.process.pid;
            console.log(`[Monitor]    Now: streaming=true, processId=${processInfo.process.pid}`);
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
      
      const activeStreams = ffmpegManager.getActiveStreams();
      console.log(`[Monitor] ✅ Check completed - Running: ${runningCount}/${cameras.length}, Restarted: ${restartedCount}`);
      console.log(`[Monitor] Active streams: [${activeStreams.join(', ')}]`);
    } catch (error) {
      console.error('[Monitor] ❌ Error checking streams:', error.message);
    }
  }

  /**
   * Restore all active streams on server start
   * This ensures 24/7 streaming - cameras restart when server restarts
   */
  async restoreStreams() {
    console.log('[Monitor] 🔄 ========================================');
    console.log('[Monitor] 🔄 RESTORING ALL ACTIVE STREAMS ON STARTUP');
    console.log('[Monitor] 🔄 ========================================');
    
    try {
      const cameras = await Camera.find({ active: true });
      console.log(`[Monitor] Found ${cameras.length} active cameras to restore`);

      if (cameras.length === 0) {
        console.log('[Monitor] ℹ️ No active cameras found - nothing to restore');
        console.log('[Monitor] 💡 Add cameras via POST /api/camera/add');
        return;
      }

      let successCount = 0;
      let failedCount = 0;

      for (const camera of cameras) {
        try {
          console.log(`\n[Monitor] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`[Monitor] 🔄 Restoring: ${camera.streamName}`);
          console.log(`[Monitor] 📹 RTSP: ${camera.rtspUrl}`);
          console.log(`[Monitor] 📍 Location: ${camera.location || 'N/A'}`);
          
          // Check if already running (shouldn't be on fresh start, but just in case)
          if (ffmpegManager.isStreamRunning(camera.streamName)) {
            console.log(`[Monitor] ℹ️ Stream ${camera.streamName} already running`);
            const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
            if (processInfo) {
              camera.streaming = true;
              camera.processId = processInfo.process.pid;
              await camera.save();
              successCount++;
              console.log(`[Monitor] ✅ Verified PID: ${processInfo.process.pid}`);
            }
            continue;
          }

          // Start the stream
          console.log(`[Monitor] 🚀 Starting FFmpeg process...`);
          await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
          console.log(`[Monitor] ⏳ Waiting for stream to stabilize (5 seconds)...`);
          
          // Wait for stream to stabilize
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Verify stream is actually running
          const isRunning = ffmpegManager.isStreamRunning(camera.streamName);
          const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
          
          if (isRunning && processInfo) {
            camera.streaming = true;
            camera.processId = processInfo.process.pid;
            camera.lastChecked = Date.now();
            await camera.save();
            successCount++;
            console.log(`[Monitor] ✅ SUCCESS - Stream ${camera.streamName} running with PID ${processInfo.process.pid}`);
            console.log(`[Monitor] 🌐 Public URL: ${ffmpegManager.getPublicUrl(camera.streamName)}`);
            console.log(`[Monitor] 📺 HLS: ${ffmpegManager.getPublicUrl(camera.streamName)}/index.m3u8`);
          } else {
            camera.streaming = false;
            camera.processId = null;
            camera.lastChecked = Date.now();
            await camera.save();
            failedCount++;
            console.log(`[Monitor] ⚠️ WARNING - Stream ${camera.streamName} started but not verified`);
            console.log(`[Monitor] 💡 Will retry in next monitoring cycle (15 seconds)`);
          }
          
          // Small delay between camera starts to avoid overwhelming system
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (error) {
          console.error(`[Monitor] ❌ FAILED to restore ${camera.streamName}:`, error.message);
          camera.streaming = false;
          camera.processId = null;
          camera.lastChecked = Date.now();
          await camera.save();
          failedCount++;
        }
      }

      console.log(`\n[Monitor] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[Monitor] ✅ RESTORATION COMPLETED`);
      console.log(`[Monitor] 📊 Success: ${successCount}/${cameras.length}`);
      console.log(`[Monitor] ❌ Failed: ${failedCount}/${cameras.length}`);
      console.log(`[Monitor] 📺 Active streams: ${ffmpegManager.getActiveStreams().length}`);
      console.log(`[Monitor] 🔄 Monitoring will auto-restart failed streams every 15 seconds`);
      console.log(`[Monitor] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      
      // List all active streams
      const activeStreams = ffmpegManager.getActiveStreams();
      if (activeStreams.length > 0) {
        console.log(`[Monitor] 📋 Active streams: [${activeStreams.join(', ')}]`);
      }
      
    } catch (error) {
      console.error('[Monitor] ❌ Error restoring streams:', error.message);
      console.error('[Monitor] Stack:', error.stack);
    }
  }

  /**
   * Force refresh status for all cameras from actual process state
   */
  async forceRefreshStatus() {
    console.log('[Monitor] 🔄 Force refreshing camera statuses...');
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
      
      console.log('[Monitor] ✅ Status refresh completed');
    } catch (error) {
      console.error('[Monitor] ❌ Error refreshing status:', error.message);
    }
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeStreams: ffmpegManager.getActiveStreams()
    };
  }
}

module.exports = new StreamMonitor();