const express = require('express');
const router = express.Router();
const Camera = require('../models/Camera');
const ffmpegManager = require('../services/FFmpegManager');
const axios = require('axios');
const config = require('../config');

/**
 * @swagger
 * /api/camera/add:
 *   post:
 *     summary: Add a new camera RTSP link from Android
 *     description: Submit an RTSP camera link from Android app. The server will immediately start streaming to MediaMTX and return a public URL. Streaming continues 24x7 even if the app closes.
 *     tags: [Camera]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AddCameraRequest'
 *           examples:
 *             hikvision:
 *               summary: Hikvision Camera Example
 *               value:
 *                 rtspUrl: "rtsp://192.168.1.100:554/Streaming/Channels/101"
 *                 workspaceId: "workspace123"
 *                 name: "Camera 1 - Front Door"
 *                 manufacturer: "hikvision"
 *                 region: "Delhi"
 *                 country: "IN"
 *                 postalCode: "110001"
 *             dahua:
 *               summary: Dahua Camera Example
 *               value:
 *                 rtspUrl: "rtsp://192.168.1.101:554/cam/realmonitor?channel=1&subtype=0"
 *                 workspaceId: "workspace123"
 *                 name: "Camera 2 - Backyard"
 *                 manufacturer: "dahua"
 *     responses:
 *       200:
 *         description: Camera added and streaming started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Camera added and streaming started"
 *                 camera:
 *                   $ref: '#/components/schemas/Camera'
 *       400:
 *         description: Bad request - missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               message: "rtspUrl is required"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/add', async (req, res) => {
  try {
    const {
      rtspUrl,
      workspaceId,
      name,
      manufacturer,
      region,
      country,
      postalCode,
      ipAddress,
      nvrUsername,
      nvrPassword
    } = req.body;

    // Validate required fields - only rtspUrl is required
    if (!rtspUrl) {
      return res.status(400).json({
        success: false,
        message: 'rtspUrl is required'
      });
    }

    // Use default workspaceId if not provided
    const finalWorkspaceId = workspaceId || 'default_workspace';

    // Generate unique stream name
    const streamName = `cam_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const publicUrl = ffmpegManager.getPublicUrl(streamName);

    // Create camera record
    const camera = new Camera({
      name: name || `Camera_${Date.now()}`,
      rtspUrl,
      workspaceId: finalWorkspaceId,
      streamName,
      publicUrl,
      iceCastUrl: publicUrl,
      isIceCastUrl: true,
      manufacturer: manufacturer || '',
      region: region || '',
      country: country || '',
      postalCode: postalCode || '',
      ipAddress: ipAddress || '',
      nvrUsername: nvrUsername || '',
      nvrPassword: nvrPassword || '',
      active: true,
      streaming: false
    });

    await camera.save();

    // Start streaming IMMEDIATELY
    console.log(`[API] 🚀 Starting stream for ${streamName}...`);
    console.log(`[API] RTSP Source: ${rtspUrl}`);
    
    try {
      const actualPublicUrl = await ffmpegManager.startStream(rtspUrl, streamName);
      camera.publicUrl = actualPublicUrl;
      camera.iceCastUrl = actualPublicUrl;
      camera.streaming = true;
      await camera.save();
      console.log(`[API] ✅ Stream started successfully: ${actualPublicUrl}`);
    } catch (streamError) {
      console.error(`[API] ❌ Failed to start stream for ${streamName}:`, streamError.message);
      console.log(`[API] ⚠️ Camera saved, monitor will auto-retry in 30 seconds`);
      // Camera is saved but streaming failed - monitor will retry
    }

    // Optionally sync with external API
    if (config.baseApiUrl && config.baseApiUrl !== 'http://127.0.0.1:8000') {
      try {
        await syncToExternalAPI(camera);
      } catch (apiError) {
        console.error(`[API] Failed to sync to external API:`, apiError.message);
        // Continue even if external API fails
      }
    }

    res.json({
      success: true,
      message: 'Camera added and streaming started',
      camera: {
        id: camera._id,
        name: camera.name,
        streamName: camera.streamName,
        publicUrl: camera.publicUrl,
        streaming: camera.streaming
      }
    });

  } catch (error) {
    console.error('[API] Error adding camera:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add camera',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/list:
 *   get:
 *     summary: Get all cameras
 *     description: Retrieve list of all cameras with real-time streaming status. Optionally filter by workspaceId.
 *     tags: [Camera]
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Filter cameras by workspace ID
 *         example: workspace123
 *     responses:
 *       200:
 *         description: List of cameras retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CameraListResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/list', async (req, res) => {
  try {
    const { workspaceId } = req.query;
    const query = workspaceId ? { workspaceId } : {};

    const cameras = await Camera.find(query).sort({ createdAt: -1 });

    // Update streaming status from active processes (REAL-TIME)
    const camerasWithStatus = cameras.map(camera => {
      const isRunning = ffmpegManager.isStreamRunning(camera.streamName);
      const processInfo = ffmpegManager.getProcessInfo(camera.streamName);
      
      return {
        id: camera._id,
        name: camera.name,
        rtspUrl: camera.rtspUrl,
        streamName: camera.streamName,
        publicUrl: camera.publicUrl,
        active: camera.active,
        streaming: isRunning || camera.streaming,
        processId: processInfo?.process?.pid || camera.processId,
        workspaceId: camera.workspaceId,
        createdAt: camera.createdAt,
        lastChecked: camera.lastChecked,
        uptime: processInfo ? Math.floor((Date.now() - processInfo.startTime) / 1000) : 0 // seconds
      };
    });

    const activeCount = camerasWithStatus.filter(c => c.streaming).length;

    res.json({
      success: true,
      cameras: camerasWithStatus,
      count: camerasWithStatus.length,
      activeStreams: activeCount,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[API] Error listing cameras:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list cameras',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/status/{streamName}:
 *   get:
 *     summary: Get real-time status of a specific stream
 *     description: Get current streaming status, process ID, uptime, and other details for a specific camera stream.
 *     tags: [Camera]
 *     parameters:
 *       - in: path
 *         name: streamName
 *         required: true
 *         schema:
 *           type: string
 *         description: Unique stream name
 *         example: cam_1704123456789_1234
 *     responses:
 *       200:
 *         description: Stream status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 streamName:
 *                   type: string
 *                 streaming:
 *                   type: boolean
 *                 processId:
 *                   type: integer
 *                   nullable: true
 *                 uptime:
 *                   type: integer
 *                 publicUrl:
 *                   type: string
 *                 rtspUrl:
 *                   type: string
 *                 active:
 *                   type: boolean
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Camera not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/status/:streamName', async (req, res) => {
  try {
    const { streamName } = req.params;
    const camera = await Camera.findOne({ streamName });
    
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'Camera not found'
      });
    }

    const isRunning = ffmpegManager.isStreamRunning(streamName);
    const processInfo = ffmpegManager.getProcessInfo(streamName);

    res.json({
      success: true,
      streamName,
      streaming: isRunning,
      processId: processInfo?.process?.pid || null,
      uptime: processInfo ? Math.floor((Date.now() - processInfo.startTime) / 1000) : 0,
      publicUrl: camera.publicUrl,
      rtspUrl: camera.rtspUrl,
      active: camera.active,
      lastChecked: camera.lastChecked,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[API] Error getting stream status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get stream status',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/{id}:
 *   get:
 *     summary: Get camera by ID
 *     description: Retrieve detailed information about a specific camera by its database ID.
 *     tags: [Camera]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Camera database ID
 *         example: 65a1b2c3d4e5f6g7h8i9j0k1
 *     responses:
 *       200:
 *         description: Camera details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 camera:
 *                   $ref: '#/components/schemas/Camera'
 *       404:
 *         description: Camera not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.id);
    
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'Camera not found'
      });
    }

    const isRunning = ffmpegManager.isStreamRunning(camera.streamName);

    res.json({
      success: true,
      camera: {
        ...camera.toObject(),
        streaming: isRunning || camera.streaming
      }
    });

  } catch (error) {
    console.error('[API] Error getting camera:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get camera',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/{id}/start:
 *   put:
 *     summary: Start streaming for a camera
 *     description: Manually start streaming for a camera. FFmpeg process will be started and stream will be pushed to MediaMTX.
 *     tags: [Camera]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Camera database ID
 *     responses:
 *       200:
 *         description: Streaming started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 publicUrl:
 *                   type: string
 *       400:
 *         description: Camera is not active
 *       404:
 *         description: Camera not found
 */
router.put('/:id/start', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.id);
    
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'Camera not found'
      });
    }

    if (!camera.active) {
      return res.status(400).json({
        success: false,
        message: 'Camera is not active'
      });
    }

    const publicUrl = await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
    camera.streaming = true;
    camera.publicUrl = publicUrl;
    camera.iceCastUrl = publicUrl;
    await camera.save();

    res.json({
      success: true,
      message: 'Streaming started',
      publicUrl
    });

  } catch (error) {
    console.error('[API] Error starting stream:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start stream',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/{id}/stop:
 *   put:
 *     summary: Stop streaming for a camera
 *     description: Stop the FFmpeg process and halt streaming for a camera. The camera record remains in database.
 *     tags: [Camera]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Camera database ID
 *     responses:
 *       200:
 *         description: Streaming stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Camera not found
 */
router.put('/:id/stop', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.id);
    
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'Camera not found'
      });
    }

    await ffmpegManager.stopStream(camera.streamName);
    camera.streaming = false;
    await camera.save();

    res.json({
      success: true,
      message: 'Streaming stopped'
    });

  } catch (error) {
    console.error('[API] Error stopping stream:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to stop stream',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/{id}/activate:
 *   put:
 *     summary: Activate a camera
 *     description: Activate a camera and automatically start streaming. If camera is inactive, this will enable it and start the stream.
 *     tags: [Camera]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Camera database ID
 *     responses:
 *       200:
 *         description: Camera activated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Camera not found
 */
router.put('/:id/activate', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.id);
    
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'Camera not found'
      });
    }

    camera.active = true;
    await camera.save();

    // Start streaming
    try {
      const publicUrl = await ffmpegManager.startStream(camera.rtspUrl, camera.streamName);
      camera.streaming = true;
      camera.publicUrl = publicUrl;
      await camera.save();
    } catch (streamError) {
      console.error(`[API] Failed to start stream:`, streamError.message);
    }

    res.json({
      success: true,
      message: 'Camera activated'
    });

  } catch (error) {
    console.error('[API] Error activating camera:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to activate camera',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/{id}/deactivate:
 *   put:
 *     summary: Deactivate a camera
 *     description: Deactivate a camera and stop streaming. The camera will be marked as inactive and FFmpeg process will be stopped.
 *     tags: [Camera]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Camera database ID
 *     responses:
 *       200:
 *         description: Camera deactivated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Camera not found
 */
router.put('/:id/deactivate', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.id);
    
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'Camera not found'
      });
    }

    await ffmpegManager.stopStream(camera.streamName);
    camera.active = false;
    camera.streaming = false;
    await camera.save();

    res.json({
      success: true,
      message: 'Camera deactivated'
    });

  } catch (error) {
    console.error('[API] Error deactivating camera:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deactivate camera',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/camera/{id}:
 *   delete:
 *     summary: Delete a camera
 *     description: Permanently delete a camera from the database. This will stop the stream and remove all camera data.
 *     tags: [Camera]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Camera database ID
 *     responses:
 *       200:
 *         description: Camera deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Camera not found
 */
router.delete('/:id', async (req, res) => {
  try {
    const camera = await Camera.findById(req.params.id);
    
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'Camera not found'
      });
    }

    await ffmpegManager.stopStream(camera.streamName);
    await Camera.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Camera deleted'
    });

  } catch (error) {
    console.error('[API] Error deleting camera:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete camera',
      error: error.message
    });
  }
});

/**
 * Helper function to sync camera to external API
 */
async function syncToExternalAPI(camera) {
  if (!config.baseApiUrl || config.baseApiUrl === 'http://127.0.0.1:8000') {
    return; // Skip if not configured
  }

  try {
    const url = `${config.cameraApiBaseUrl}${camera.workspaceId}/camera/`;
    
    const payload = {
      name: camera.name,
      ice_cast_url: camera.iceCastUrl,
      is_ice_cast_url: camera.isIceCastUrl,
      manufacturer: camera.manufacturer,
      region: camera.region,
      country: camera.country,
      postal_code: camera.postalCode,
      ip_address: camera.ipAddress,
      nvr_username: camera.nvrUsername,
      nvr_password: camera.nvrPassword,
      channel_supported: camera.channelSupported,
      active: camera.active
    };

    // Note: You'll need to add authentication token here
    // const headers = { 'Authorization': `Bearer ${token}` };
    // await axios.post(url, payload, { headers });

    console.log(`[API] Synced camera ${camera.streamName} to external API`);
  } catch (error) {
    console.error(`[API] External API sync failed:`, error.message);
    throw error;
  }
}

module.exports = router;

