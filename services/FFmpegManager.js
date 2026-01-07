const { spawn } = require('child_process');
const config = require('../config');
const Camera = require('../models/Camera');

class FFmpegManager {
  constructor() {
    this.processes = new Map(); // Map<streamName, process>
    this.isShuttingDown = false;
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
      '-loglevel', 'warning',  // Changed from 'info' to reduce noise
      '-rtsp_transport', 'tcp',
      '-rtsp_flags', 'prefer_tcp',
      '-stimeout', '5000000',  // 5 second timeout for RTSP connection
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      '-fflags', '+genpts+nobuffer',
      '-use_wallclock_as_timestamps', '1',
      '-allowed_media_types', 'video',  // Only process video
      '-i', rtspSource,
      '-map', '0:v:0',
      // Handle both H.264 and HEVC/H.265 input
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
      '-strict', 'experimental',  // Allow experimental codecs if needed
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
        restartCount: 0
      };

      this.processes.set(streamName, processInfo);

      // Handle stdout
      ffmpegProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[FFmpeg ${streamName}] ${output.trim()}`);
      });

      // Handle stderr
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // FFmpeg outputs to stderr, so we log it
        // Filter out common HEVC decoder warnings that don't affect streaming
        const isHevcWarning = output.includes('[hevc @') && 
                              (output.includes('Could not find ref') || 
                               output.includes('Error constructing') ||
                               output.includes('Skipping invalid'));
        
        // Only log real errors, not HEVC decoder warnings
        if (output.includes('error') || output.includes('Error')) {
          if (!isHevcWarning) {
            console.error(`[FFmpeg ${streamName}] ${output.trim()}`);
          }
        } else if (output.includes('Stream #0') || output.includes('Output #0') || output.includes('frame=')) {
          // Log important stream info
          console.log(`[FFmpeg ${streamName}] ${output.trim()}`);
        }
      });

      // Handle process exit
      ffmpegProcess.on('exit', async (code, signal) => {
        console.log(`[FFmpeg ${streamName}] Process exited with code ${code}, signal ${signal}`);
        
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

        // Auto-restart if not shutting down - ALWAYS restart to ensure 24/7 streaming
        if (!this.isShuttingDown) {
          const maxRetries = 10; // Maximum retry attempts
          const retryDelay = Math.min(2000 * Math.pow(1.5, processInfo.restartCount), 30000); // Exponential backoff, max 30s
          
          if (processInfo.restartCount < maxRetries) {
            console.log(`[FFmpeg ${streamName}] Auto-restarting in ${retryDelay/1000} seconds... (Attempt ${processInfo.restartCount + 1}/${maxRetries})`);
            processInfo.restartCount++;
            
            setTimeout(async () => {
              try {
                const camera = await Camera.findOne({ streamName, active: true });
                if (camera) {
                  console.log(`[FFmpeg ${streamName}] 🔄 Restarting stream (attempt ${processInfo.restartCount})...`);
                  await this.startStream(camera.rtspUrl, streamName);
                } else {
                  console.log(`[FFmpeg ${streamName}] Camera not found or inactive, stopping retries`);
                }
              } catch (error) {
                console.error(`[FFmpeg ${streamName}] Restart failed:`, error.message);
                // Will be retried by StreamMonitor
              }
            }, retryDelay);
          } else {
            console.error(`[FFmpeg ${streamName}] Max retries reached, StreamMonitor will handle restart`);
            // StreamMonitor will pick this up and restart
          }
        }
      });

      // Handle errors - don't reject immediately, try to restart
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
        
        reject(error);
      });

      // Give it a moment to start
      setTimeout(() => {
        if (ffmpegProcess.pid) {
          console.log(`[FFmpeg ${streamName}] ✅ Started with PID ${ffmpegProcess.pid}`);
          console.log(`[FFmpeg ${streamName}] 📹 Source: ${rtspSource}`);
          console.log(`[FFmpeg ${streamName}] 🌐 Public URL: ${publicUrl}`);
          
          // Update database
          Camera.updateOne(
            { streamName },
            { 
              streaming: true,
              processId: ffmpegProcess.pid,
              lastChecked: Date.now()
            }
          ).catch(err => console.error(`[FFmpeg ${streamName}] DB update error:`, err.message));

          resolve(publicUrl);
        } else {
          console.error(`[FFmpeg ${streamName}] ❌ Process failed to start`);
          reject(new Error('FFmpeg process failed to start'));
        }
      }, 1000);
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

