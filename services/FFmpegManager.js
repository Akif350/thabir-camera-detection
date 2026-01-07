const { spawn } = require('child_process');
const config = require('../config');
const Camera = require('../models/Camera');
const http = require('http');

class FFmpegManager {
  constructor() {
    this.processes = new Map(); // Map<streamName, process>
    this.isShuttingDown = false;
  }

  /**
   * Check if stream is available on MediaMTX
   * @param {string} streamName - Stream name to check
   * @returns {Promise<boolean>} True if stream is available
   */
  async checkStreamAvailability(streamName) {
    const publicUrl = this.getPublicUrl(streamName);
    
    return new Promise((resolve) => {
      const req = http.get(publicUrl, (res) => {
        // If we get any response (even 404), MediaMTX is responding
        // 200 = stream ready, 404 = not ready yet
        resolve(res.statusCode === 200);
        res.resume(); // Consume response
      });

      req.on('error', () => {
        resolve(false);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Wait for stream to be ready on MediaMTX with polling
   * @param {string} streamName - Stream name
   * @param {number} maxWaitTime - Maximum time to wait in ms
   * @returns {Promise<boolean>} True if stream became ready
   */
  async waitForStreamReady(streamName, maxWaitTime = 15000) {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every 1 second
    
    while (Date.now() - startTime < maxWaitTime) {
      const isReady = await this.checkStreamAvailability(streamName);
      
      if (isReady) {
        console.log(`[FFmpeg ${streamName}] ✅ Stream verified ready on MediaMTX after ${Math.round((Date.now() - startTime) / 1000)}s`);
        return true;
      }
      
      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      console.log(`[FFmpeg ${streamName}] ⏳ Waiting for stream... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    }
    
    console.warn(`[FFmpeg ${streamName}] ⚠️ Stream not ready after ${maxWaitTime/1000}s, but continuing anyway`);
    return false;
  }

  /**
   * Start streaming an RTSP source to MediaMTX
   * @param {string} rtspSource - Source RTSP URL
   * @param {string} streamName - Unique stream name for MediaMTX
   * @returns {Promise<string>} Public HTTP URL for the stream
   */
  async startStream(rtspSource, streamName) {
    if (this.processes.has(streamName)) {
      console.log(`[FFmpeg] Stream ${streamName} already running`);
      return this.getPublicUrl(streamName);
    }

    const pushTarget = `${config.mediamtx.getPushBase()}/${streamName}`;
    const publicUrl = `${config.mediamtx.getPublicBase()}/${streamName}`;

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-rtsp_flags', 'prefer_tcp',
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      '-fflags', '+genpts+nobuffer',
      '-use_wallclock_as_timestamps', '1',
      '-allowed_media_types', 'video',
      '-i', rtspSource,
      '-map', '0:v:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-pix_fmt', 'yuv420p',
      '-g', '30',
      '-keyint_min', '30',
      '-x264-params', 'scenecut=0:sync-lookahead=0:sliced-threads=1',
      '-b:v', '2.5M',
      '-maxrate', '2.5M',
      '-bufsize', '5M',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      '-rtsp_flags', 'prefer_tcp',
      '-muxdelay', '0',
      '-strict', 'experimental',
      pushTarget
    ];

    return new Promise((resolve, reject) => {
      const ffmpegProcess = spawn(config.ffmpeg.path, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      // Store process info
      const processInfo = {
        process: ffmpegProcess,
        streamName,
        rtspSource,
        startTime: Date.now(),
        restartCount: 0,
        isStarting: true // Flag to indicate stream is still starting
      };

      this.processes.set(streamName, processInfo);

      let hasResolved = false;
      let streamConnectionDetected = false;

      // Handle stdout
      ffmpegProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[FFmpeg ${streamName}] ${output.trim()}`);
      });

      // Handle stderr
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        
        // Filter out HEVC decoder warnings
        const isHevcWarning = output.includes('[hevc @') && 
                              (output.includes('Could not find ref') || 
                               output.includes('Error constructing') ||
                               output.includes('Skipping invalid'));
        
        // Detect when FFmpeg starts processing frames - this means RTSP connection is established
        if ((output.includes('frame=') || output.includes('fps=')) && !streamConnectionDetected) {
          streamConnectionDetected = true;
          console.log(`[FFmpeg ${streamName}] 🎬 Stream processing started - frames being encoded`);
        }
        
        // Check for stream ready indicators
        if (output.includes('Stream #0') || output.includes('Output #0')) {
          console.log(`[FFmpeg ${streamName}] ${output.trim()}`);
        }
        
        // Only log real errors, not HEVC decoder warnings
        if ((output.includes('error') || output.includes('Error')) && !isHevcWarning) {
          console.error(`[FFmpeg ${streamName}] ${output.trim()}`);
        }
      });

      // Handle process exit
      ffmpegProcess.on('exit', async (code, signal) => {
        console.log(`[FFmpeg ${streamName}] Process exited with code ${code}, signal ${signal}`);
        
        const wasStarting = processInfo.isStarting;
        
        // Remove from active processes
        this.processes.delete(streamName);

        // Update database
        try {
          await Camera.updateOne(
            { streamName },
            { 
              streaming: false,
              processId: null,
              lastChecked: Date.now()
            }
          );
        } catch (error) {
          console.error(`[FFmpeg ${streamName}] Error updating database:`, error.message);
        }

        // If exited during startup and haven't resolved yet, reject
        if (wasStarting && !hasResolved) {
          reject(new Error(`FFmpeg process exited during startup with code ${code}`));
          return;
        }

        // Auto-restart if not shutting down
        if (!this.isShuttingDown) {
          const maxRetries = 10;
          const retryDelay = Math.min(2000 * Math.pow(1.5, processInfo.restartCount), 30000);
          
          if (processInfo.restartCount < maxRetries) {
            console.log(`[FFmpeg ${streamName}] Auto-restarting in ${retryDelay/1000} seconds... (Attempt ${processInfo.restartCount + 1}/${maxRetries})`);
            
            setTimeout(async () => {
              try {
                const camera = await Camera.findOne({ streamName, active: true });
                if (camera) {
                  console.log(`[FFmpeg ${streamName}] 🔄 Restarting stream (attempt ${processInfo.restartCount + 1})...`);
                  processInfo.restartCount++;
                  await this.startStream(camera.rtspUrl, streamName);
                } else {
                  console.log(`[FFmpeg ${streamName}] Camera not found or inactive, stopping retries`);
                }
              } catch (error) {
                console.error(`[FFmpeg ${streamName}] Restart failed:`, error.message);
              }
            }, retryDelay);
          } else {
            console.error(`[FFmpeg ${streamName}] Max retries reached, StreamMonitor will handle restart`);
          }
        }
      });

      // Handle errors
      ffmpegProcess.on('error', async (error) => {
        console.error(`[FFmpeg ${streamName}] Process error:`, error.message);
        this.processes.delete(streamName);
        
        // Update database
        try {
          await Camera.updateOne(
            { streamName },
            { 
              streaming: false,
              processId: null,
              lastChecked: Date.now()
            }
          );
        } catch (dbError) {
          console.error(`[FFmpeg ${streamName}] DB update error:`, dbError.message);
        }
        
        if (!hasResolved) {
          reject(error);
        }
        
        // Auto-restart on error if not shutting down
        if (!this.isShuttingDown) {
          setTimeout(async () => {
            try {
              const camera = await Camera.findOne({ streamName, active: true });
              if (camera) {
                console.log(`[FFmpeg ${streamName}] 🔄 Restarting after error...`);
                await this.startStream(camera.rtspUrl, streamName);
              }
            } catch (restartError) {
              console.error(`[FFmpeg ${streamName}] Error restart failed:`, restartError.message);
            }
          }, 3000);
        }
      });

      // Wait for FFmpeg process to start
      setTimeout(async () => {
        if (!ffmpegProcess.pid) {
          console.error(`[FFmpeg ${streamName}] ❌ Process failed to start`);
          this.processes.delete(streamName);
          reject(new Error('FFmpeg process failed to start'));
          return;
        }

        console.log(`[FFmpeg ${streamName}] ✅ FFmpeg started with PID ${ffmpegProcess.pid}`);
        console.log(`[FFmpeg ${streamName}] 📹 Source: ${rtspSource}`);
        console.log(`[FFmpeg ${streamName}] 🌐 Public URL: ${publicUrl}`);
        console.log(`[FFmpeg ${streamName}] ⏳ Waiting for stream to be available on MediaMTX...`);

        try {
          // Wait for stream to be ready on MediaMTX with polling
          await this.waitForStreamReady(streamName, 20000); // 20 second max wait
          
          // Mark as no longer starting
          if (this.processes.has(streamName)) {
            this.processes.get(streamName).isStarting = false;
          }
          
          // Update database
          await Camera.updateOne(
            { streamName },
            { 
              streaming: true,
              processId: ffmpegProcess.pid,
              lastChecked: Date.now()
            }
          );
          
          console.log(`[FFmpeg ${streamName}] ✅ Stream ready and available at: ${publicUrl}`);
          hasResolved = true;
          resolve(publicUrl);
          
        } catch (err) {
          console.error(`[FFmpeg ${streamName}] Error during stream ready check:`, err.message);
          // Still resolve with URL - stream might become ready soon
          hasResolved = true;
          resolve(publicUrl);
        }
      }, 3000); // Wait 3 seconds for FFmpeg to fully start
    });
  }

  /**
   * Stop a specific stream
   */
  async stopStream(streamName) {
    const processInfo = this.processes.get(streamName);
    if (processInfo) {
      console.log(`[FFmpeg] Stopping stream ${streamName}`);
      processInfo.process.kill('SIGTERM');
      this.processes.delete(streamName);
      
      // Update database
      await Camera.updateOne(
        { streamName },
        { 
          streaming: false,
          processId: null,
          lastChecked: Date.now()
        }
      );
      
      return true;
    }
    return false;
  }

  /**
   * Stop all streams
   */
  async stopAll() {
    console.log('[FFmpeg] Stopping all streams...');
    this.isShuttingDown = true;
    
    const promises = Array.from(this.processes.keys()).map(streamName => 
      this.stopStream(streamName)
    );
    
    await Promise.all(promises);
    console.log('[FFmpeg] All streams stopped');
  }

  /**
   * Get public URL for a stream
   */
  getPublicUrl(streamName) {
    return `${config.mediamtx.getPublicBase()}/${streamName}`;
  }

  /**
   * Check if a stream is running
   */
  isStreamRunning(streamName) {
    return this.processes.has(streamName);
  }

  /**
   * Check if a stream is still starting up
   */
  isStreamStarting(streamName) {
    const processInfo = this.processes.get(streamName);
    return processInfo && processInfo.isStarting;
  }

  /**
   * Get all active streams
   */
  getActiveStreams() {
    return Array.from(this.processes.keys());
  }

  /**
   * Get process info for a stream
   */
  getProcessInfo(streamName) {
    return this.processes.get(streamName);
  }
}

// Singleton instance
const ffmpegManager = new FFmpegManager();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[System] SIGTERM received, shutting down gracefully...');
  await ffmpegManager.stopAll();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[System] SIGINT received, shutting down gracefully...');
  await ffmpegManager.stopAll();
  process.exit(0);
});

module.exports = ffmpegManager;