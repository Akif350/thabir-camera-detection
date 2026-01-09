const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
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
    // Check if stream already running
    if (this.processes.has(streamName)) {
      const processInfo = this.processes.get(streamName);
      // Verify process is actually alive
      try {
        if (processInfo.process.pid) {
          process.kill(processInfo.process.pid, 0);
          console.log(`[FFmpeg] Stream ${streamName} already running with PID ${processInfo.process.pid}`);
          return this.getPublicUrl(streamName);
        }
      } catch (err) {
        // Process died, remove from map and continue to restart
        console.log(`[FFmpeg] Stream ${streamName} process dead, removing from map`);
        this.processes.delete(streamName);
      }
    }

    const pushTarget = `${config.mediamtx.getPushBase()}/${streamName}`;
    const publicUrl = `${config.mediamtx.getPublicBase()}/${streamName}`;

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-rtsp_flags', 'prefer_tcp',
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
      console.log(`[FFmpeg ${streamName}] 🚀 Starting stream process...`);
      console.log(`[FFmpeg ${streamName}] 📹 Source: ${rtspSource}`);
      console.log(`[FFmpeg ${streamName}] 📤 Push to: ${pushTarget}`);
      
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
        isValidated: false
      };

      this.processes.set(streamName, processInfo);

      let streamStarted = false;
      let streamValidated = false;
      let resolvePromiseCalled = false;

      // Handle stdout
      ffmpegProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[FFmpeg ${streamName}] ${output.trim()}`);
      });

      // Handle stderr
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        
        // Filter out common HEVC decoder warnings
        const isHevcWarning = output.includes('[hevc @') && 
                              (output.includes('Could not find ref') || 
                               output.includes('Error constructing') ||
                               output.includes('Skipping invalid'));
        
        // Check for stream ready indicators
        if (output.includes('Stream #0') || output.includes('Output #0') || 
            output.includes('frame=') || output.includes('Stream mapping')) {
          if (!isHevcWarning) {
            console.log(`[FFmpeg ${streamName}] ${output.trim()}`);
          }
          if ((output.includes('Stream #0') || output.includes('Stream mapping')) && !streamStarted) {
            streamStarted = true;
            console.log(`[FFmpeg ${streamName}] 📡 Stream processing detected - connection established`);
          }
        }
        
        // Check for successful MediaMTX connection
        if (output.includes('rtsp://') && (output.includes('succeeded') || output.includes('Opening'))) {
          console.log(`[FFmpeg ${streamName}] ✅ Connected to MediaMTX`);
        }
        
        // Log errors (except HEVC warnings)
        if ((output.includes('error') || output.includes('Error') || 
             output.includes('failed') || output.includes('Failed')) && !isHevcWarning) {
          console.error(`[FFmpeg ${streamName}] ❌ ${output.trim()}`);
        }
      });

      // Handle process exit
      ffmpegProcess.on('exit', async (code, signal) => {
        console.log(`[FFmpeg ${streamName}] Process exited with code ${code}, signal ${signal}`);
        
        // Remove from active processes
        this.processes.delete(streamName);

        // Update database - mark as not streaming
        try {
          await Camera.updateOne(
            { streamName },
            { 
              streaming: false,
              processId: null,
              lastChecked: Date.now()
            }
          );
          console.log(`[FFmpeg ${streamName}] Database updated: streaming = false`);
        } catch (error) {
          console.error(`[FFmpeg ${streamName}] Error updating database:`, error.message);
        }

        // Auto-restart if not shutting down and was validated
        if (!this.isShuttingDown && processInfo.isValidated) {
          const maxRetries = 10;
          const retryDelay = Math.min(2000 * Math.pow(1.5, processInfo.restartCount || 0), 30000);
          
          if ((processInfo.restartCount || 0) < maxRetries) {
            console.log(`[FFmpeg ${streamName}] Auto-restarting in ${retryDelay/1000}s... (Attempt ${(processInfo.restartCount || 0) + 1}/${maxRetries})`);
            
            setTimeout(async () => {
              try {
                const camera = await Camera.findOne({ streamName, active: true });
                if (camera) {
                  console.log(`[FFmpeg ${streamName}] 🔄 Restarting stream...`);
                  processInfo.restartCount = (processInfo.restartCount || 0) + 1;
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

      // Handle process errors
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
        
        if (!resolvePromiseCalled) {
          resolvePromiseCalled = true;
          reject(error);
        }
      });

      // Validation function - checks if process is actually running
      const validateProcess = async () => {
        try {
          // Check if process exists
          if (!ffmpegProcess.pid) {
            throw new Error('Process has no PID');
          }

          // Verify process is actually running (cross-platform check)
          try {
            process.kill(ffmpegProcess.pid, 0); // Signal 0 checks if process exists
          } catch (err) {
            throw new Error(`Process ${ffmpegProcess.pid} does not exist`);
          }

          // Check if still in our processes map
          if (!this.processes.has(streamName)) {
            throw new Error('Process removed from active streams');
          }

          return true;
        } catch (error) {
          console.error(`[FFmpeg ${streamName}] Validation failed:`, error.message);
          return false;
        }
      };

      // Wait for process to start
      setTimeout(async () => {
        if (!ffmpegProcess.pid) {
          console.error(`[FFmpeg ${streamName}] ❌ Process failed to start`);
          this.processes.delete(streamName);
          if (!resolvePromiseCalled) {
            resolvePromiseCalled = true;
            reject(new Error('FFmpeg process failed to start'));
          }
          return;
        }

        console.log(`[FFmpeg ${streamName}] ✅ Started with PID ${ffmpegProcess.pid}`);
        console.log(`[FFmpeg ${streamName}] 🌐 Public URL: ${publicUrl}`);
        console.log(`[FFmpeg ${streamName}] ⏳ Validating stream stability...`);

        // Wait for MediaMTX to be ready and stream to stabilize
        setTimeout(async () => {
          // Validate process is still running
          const isValid = await validateProcess();
          
          if (!isValid) {
            console.error(`[FFmpeg ${streamName}] ❌ Process validation failed - stream not stable`);
            try {
              await Camera.updateOne(
                { streamName },
                { 
                  streaming: false,
                  processId: null,
                  lastChecked: Date.now()
                }
              );
            } catch (err) {
              console.error(`[FFmpeg ${streamName}] DB update error:`, err.message);
            }
            // Resolve anyway - let StreamMonitor handle restart
            if (!resolvePromiseCalled) {
              resolvePromiseCalled = true;
              resolve(publicUrl);
            }
            return;
          }

          // Process is valid and running - now verify stream is actually available on MediaMTX
          console.log(`[FFmpeg ${streamName}] 🔍 Verifying stream is available on MediaMTX...`);
          const isStreamAvailable = await this.verifyStreamAvailability(streamName, 5, 2000);
          
          // Process is valid and running - update database
          processInfo.isValidated = true;
          streamValidated = true;

          try {
            const updateResult = await Camera.updateOne(
              { streamName },
              { 
                streaming: true,
                processId: ffmpegProcess.pid,
                lastChecked: Date.now()
              }
            );
            
            if (isStreamAvailable) {
              console.log(`[FFmpeg ${streamName}] ✅ Stream validated and available on MediaMTX`);
              console.log(`[FFmpeg ${streamName}] ✅ Stream marked as streaming in database`);
              console.log(`[FFmpeg ${streamName}] 📺 Stream URL: ${publicUrl}`);
              console.log(`[FFmpeg ${streamName}] 📺 HLS Manifest: ${publicUrl}/index.m3u8`);
              console.log(`[FFmpeg ${streamName}] ✅ Stream ready for all devices (mobile, network, etc.)`);
            } else {
              console.log(`[FFmpeg ${streamName}] ⚠️ Stream process running but MediaMTX endpoint not yet available`);
              console.log(`[FFmpeg ${streamName}] ⚠️ Stream may still be initializing - will be available shortly`);
              console.log(`[FFmpeg ${streamName}] 📺 Stream URL: ${publicUrl}`);
            }
            
            if (!resolvePromiseCalled) {
              resolvePromiseCalled = true;
              resolve(publicUrl);
            }
          } catch (err) {
            console.error(`[FFmpeg ${streamName}] ❌ Database update error:`, err.message);
            // Still resolve since stream is running
            if (!resolvePromiseCalled) {
              resolvePromiseCalled = true;
              resolve(publicUrl);
            }
          }
        }, 15000); // 15 seconds total wait for MediaMTX to generate HLS and be ready
      }, 2000); // 2 seconds initial wait for process to start

      // Fallback timeout
      setTimeout(() => {
        if (!streamValidated && !resolvePromiseCalled) {
          console.log(`[FFmpeg ${streamName}] ⚠️ Validation timeout, resolving with warning`);
          resolvePromiseCalled = true;
          resolve(publicUrl);
        }
      }, 15000); // 15 second absolute timeout
    });
  }

  /**
   * Stop a specific stream
   */
  async stopStream(streamName) {
    const processInfo = this.processes.get(streamName);
    if (processInfo) {
      console.log(`[FFmpeg] Stopping stream ${streamName} (PID: ${processInfo.process.pid})`);
      
      try {
        // Try graceful shutdown first
        if (processInfo.process && !processInfo.process.killed) {
          processInfo.process.kill('SIGTERM');
          
          // Wait up to 3 seconds for graceful shutdown
          let killed = false;
          const killTimeout = setTimeout(() => {
            if (!killed) {
              try {
                process.kill(processInfo.process.pid, 'SIGKILL');
                console.log(`[FFmpeg] Force killed process ${processInfo.process.pid} for ${streamName}`);
              } catch (err) {
                // Process already dead
              }
            }
          }, 3000);
          
          processInfo.process.once('exit', () => {
            killed = true;
            clearTimeout(killTimeout);
          });
        }
      } catch (err) {
        console.error(`[FFmpeg] Error killing process:`, err.message);
        // Try force kill
        try {
          if (processInfo.process && processInfo.process.pid) {
            process.kill(processInfo.process.pid, 'SIGKILL');
          }
        } catch (killErr) {
          // Process already dead, ignore
        }
      }
      
      this.processes.delete(streamName);
      
      // Update database - mark stream as stopped
      try {
        await Camera.updateOne(
          { streamName },
          { 
            streaming: false,
            processId: null,
            lastChecked: Date.now()
          }
        );
        console.log(`[FFmpeg] ✅ Database updated for ${streamName}: streaming = false`);
      } catch (err) {
        console.error(`[FFmpeg] ❌ DB update error:`, err.message);
      }
      
      return true;
    }
    console.log(`[FFmpeg] Stream ${streamName} not found in active processes`);
    return false;
  }

  /**
   * Stop all streams
   */
  async stopAll() {
    console.log('[FFmpeg] ════════════════════════════════════════════════════');
    console.log('[FFmpeg] Stopping all active video streams...');
    console.log(`[FFmpeg] Active streams: ${this.processes.size}`);
    this.isShuttingDown = true;
    
    if (this.processes.size === 0) {
      console.log('[FFmpeg] No active streams to stop');
      return;
    }

    const streamNames = Array.from(this.processes.keys());
    console.log(`[FFmpeg] Stopping streams: [${streamNames.join(', ')}]`);
    
    // Stop all streams in parallel
    const promises = streamNames.map(async (streamName) => {
      try {
        await this.stopStream(streamName);
        console.log(`[FFmpeg] ✅ Stopped stream: ${streamName}`);
      } catch (error) {
        console.error(`[FFmpeg] ❌ Error stopping stream ${streamName}:`, error.message);
      }
    });
    
    await Promise.all(promises);
    
    // Force kill any remaining processes
    for (const [streamName, processInfo] of this.processes.entries()) {
      try {
        if (processInfo.process && processInfo.process.pid) {
          console.log(`[FFmpeg] 🔪 Force killing process ${processInfo.process.pid} for ${streamName}`);
          process.kill(processInfo.process.pid, 'SIGKILL');
        }
      } catch (error) {
        // Process already dead, ignore
      }
    }
    
    this.processes.clear();
    console.log('[FFmpeg] ✅ All streams stopped successfully');
    console.log('[FFmpeg] ════════════════════════════════════════════════════');
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
    const processInfo = this.processes.get(streamName);
    if (!processInfo) return false;
    
    // Double check process is actually alive
    try {
      if (processInfo.process.pid) {
        process.kill(processInfo.process.pid, 0);
        return true;
      }
    } catch (err) {
      // Process doesn't exist
      this.processes.delete(streamName);
      return false;
    }
    
    return false;
  }

  /**
   * Get all active streams
   */
  getActiveStreams() {
    // Clean up any dead processes first
    for (const [streamName, processInfo] of this.processes.entries()) {
      try {
        if (processInfo.process.pid) {
          process.kill(processInfo.process.pid, 0);
        }
      } catch (err) {
        // Process is dead, remove it
        this.processes.delete(streamName);
      }
    }
    
    return Array.from(this.processes.keys());
  }

  /**
   * Get process info for a stream
   */
  getProcessInfo(streamName) {
    return this.processes.get(streamName);
  }

  /**
   * Verify that stream is actually available on MediaMTX HTTP endpoint
   * This checks if the stream can be accessed via HTTP (HLS manifest)
   */
  async verifyStreamAvailability(streamName, maxRetries = 5, retryDelay = 2000) {
    const publicUrl = this.getPublicUrl(streamName);
    const hlsUrl = `${publicUrl}/index.m3u8`;
    
    console.log(`[FFmpeg ${streamName}] 🔍 Verifying stream availability: ${hlsUrl}`);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const isAvailable = await this.checkHttpEndpoint(hlsUrl);
        if (isAvailable) {
          console.log(`[FFmpeg ${streamName}] ✅ Stream verified available on MediaMTX (attempt ${attempt}/${maxRetries})`);
          return true;
        }
        
        if (attempt < maxRetries) {
          console.log(`[FFmpeg ${streamName}] ⏳ Stream not yet available, retrying in ${retryDelay/1000}s... (attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        console.log(`[FFmpeg ${streamName}] ⚠️ Stream check failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    console.log(`[FFmpeg ${streamName}] ⚠️ Stream not verified after ${maxRetries} attempts - may still be initializing`);
    return false;
  }

  /**
   * Check if HTTP endpoint is accessible
   * Tries HEAD first, then GET if HEAD fails
   */
  async checkHttpEndpoint(url) {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      
      const makeRequest = (method) => {
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: method,
          timeout: 5000
        };

        const req = httpModule.request(options, (res) => {
          // Stream is available if we get 200 OK
          // 404 means stream not found (not available yet)
          // Other 4xx/5xx also mean not available
          const isAvailable = res.statusCode === 200;
          
          // For GET requests, we need to consume the response body
          if (method === 'GET') {
            let dataReceived = false;
            res.on('data', (chunk) => {
              dataReceived = true;
            });
            res.on('end', () => {
              resolve(isAvailable && dataReceived);
            });
          } else {
            // For HEAD, just check status
            res.on('data', () => {}); // Consume response
            res.on('end', () => {
              resolve(isAvailable);
            });
          }
        });

        req.on('error', (error) => {
          // Connection error means stream is not available
          if (method === 'HEAD') {
            // Try GET as fallback
            makeRequest('GET');
          } else {
            resolve(false);
          }
        });

        req.on('timeout', () => {
          req.destroy();
          if (method === 'HEAD') {
            // Try GET as fallback
            makeRequest('GET');
          } else {
            resolve(false);
          }
        });

        req.end();
      };

      // Start with HEAD request
      makeRequest('HEAD');
    });
  }
}

// Singleton instance
const ffmpegManager = new FFmpegManager();

// Graceful shutdown handlers
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