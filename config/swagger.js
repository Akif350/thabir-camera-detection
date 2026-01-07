const swaggerJsdoc = require('swagger-jsdoc');
const config = require('../config');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Thabir Streaming Server API',
      version: '1.0.0',
      description: '24x7 RTSP streaming server with MediaMTX integration. This API allows Android apps to submit RTSP camera links and automatically start 24x7 live streaming.',
      contact: {
        name: 'Thabir API Support',
        email: 'support@thabir.ai'
      },
      license: {
        name: 'ISC',
        url: 'https://opensource.org/licenses/ISC'
      }
    },
    servers: [
      {
        url: 'https://thabir-camera-detection-production.up.railway.app',
        description: 'Railway Production Server'
      },
      {
        url: `http://localhost:${config.port}`,
        description: 'Development server'
      },
      {
        url: 'https://api.thabir.ai',
        description: 'Production server (Custom Domain)'
      }
    ],
    tags: [
      {
        name: 'Camera',
        description: 'Camera and RTSP stream management endpoints'
      },
      {
        name: 'Health',
        description: 'Server health and status endpoints'
      }
    ],
    components: {
      schemas: {
        Camera: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Camera unique identifier',
              example: '65a1b2c3d4e5f6g7h8i9j0k1'
            },
            name: {
              type: 'string',
              description: 'Camera name',
              example: 'Camera 1 - Front Door'
            },
            rtspUrl: {
              type: 'string',
              description: 'Source RTSP URL',
              example: 'rtsp://192.168.1.100:554/Streaming/Channels/101'
            },
            streamName: {
              type: 'string',
              description: 'Unique stream name for MediaMTX',
              example: 'cam_1704123456789_1234'
            },
            publicUrl: {
              type: 'string',
              description: 'Public HTTP URL for viewing stream',
              example: 'https://cctv.thabir.ai:8888/cam_1704123456789_1234'
            },
            workspaceId: {
              type: 'string',
              description: 'Workspace identifier',
              example: 'workspace123'
            },
            active: {
              type: 'boolean',
              description: 'Whether camera is active',
              example: true
            },
            streaming: {
              type: 'boolean',
              description: 'Current streaming status',
              example: true
            },
            processId: {
              type: 'integer',
              description: 'FFmpeg process ID',
              example: 12345,
              nullable: true
            },
            uptime: {
              type: 'integer',
              description: 'Stream uptime in seconds',
              example: 3600
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Camera creation timestamp'
            },
            lastChecked: {
              type: 'string',
              format: 'date-time',
              description: 'Last status check timestamp'
            }
          }
        },
        AddCameraRequest: {
          type: 'object',
          required: ['rtspUrl'],
          properties: {
            rtspUrl: {
              type: 'string',
              description: 'RTSP source URL from Android (REQUIRED)',
              example: 'rtsp://192.168.1.100:554/Streaming/Channels/101'
            },
            workspaceId: {
              type: 'string',
              description: 'Workspace identifier (optional, defaults to "default_workspace")',
              example: 'workspace123'
            },
            name: {
              type: 'string',
              description: 'Camera name (optional)',
              example: 'Camera 1 - Front Door'
            },
            manufacturer: {
              type: 'string',
              description: 'Camera manufacturer (optional)',
              example: 'hikvision',
              enum: ['hikvision', 'dahua', 'axis', 'bosch', 'hanwha', 'uniview', 'cp_plus', 'other']
            },
            region: {
              type: 'string',
              description: 'Region (optional)',
              example: 'Delhi'
            },
            country: {
              type: 'string',
              description: 'Country code (optional)',
              example: 'IN'
            },
            postalCode: {
              type: 'string',
              description: 'Postal code (optional)',
              example: '110001'
            },
            ipAddress: {
              type: 'string',
              description: 'Camera IP address (optional)',
              example: '192.168.1.100'
            },
            nvrUsername: {
              type: 'string',
              description: 'NVR username (optional)',
              example: 'admin'
            },
            nvrPassword: {
              type: 'string',
              description: 'NVR password (optional)',
              example: 'password123'
            }
          }
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            message: {
              type: 'string',
              example: 'Operation successful'
            }
          }
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false
            },
            message: {
              type: 'string',
              example: 'Error message'
            },
            error: {
              type: 'string',
              example: 'Detailed error description'
            }
          }
        },
        CameraListResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            cameras: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/Camera'
              }
            },
            count: {
              type: 'integer',
              example: 5
            },
            activeStreams: {
              type: 'integer',
              example: 3
            },
            timestamp: {
              type: 'string',
              format: 'date-time'
            }
          }
        }
      }
    }
  },
  apis: [__dirname + '/../routes/*.js', __dirname + '/../server.js']
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;

