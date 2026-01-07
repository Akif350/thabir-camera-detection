require('dotenv').config();

module.exports = {
  // Server
  port: process.env.PORT || 9001,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Database
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/thabir',
  
  // External API
  baseApiUrl: process.env.BASE_API_URL || 'http://127.0.0.1:8000',
  apiLoginUrl: process.env.API_LOGIN_URL || 'http://127.0.0.1:8000/api/auth/token/',
  cameraApiBaseUrl: process.env.CAMERA_API_BASE_URL || 'http://127.0.0.1:8000/api/workspace/',
  
  // MediaMTX
  mediamtx: {
    host: process.env.MEDIAMTX_HOST || 'cctv.thabir.ai',
    rtspPort: parseInt(process.env.MEDIAMTX_RTSP_PORT) || 8554,
    httpPort: parseInt(process.env.MEDIAMTX_HTTP_PORT) || 8888,
    protocol: process.env.MEDIAMTX_PROTOCOL || 'http', // http or https
    user: process.env.MEDIAMTX_USER || '',
    pass: process.env.MEDIAMTX_PASS || '',
    getPushBase() {
      if (this.user && this.pass) {
        return `rtsp://${this.user}:${this.pass}@${this.host}:${this.rtspPort}`;
      }
      return `rtsp://${this.host}:${this.rtspPort}`;
    },
    getPublicBase() {
      // Use explicit protocol from env, or auto-detect for localhost
      let protocol = this.protocol;
      if (!protocol || protocol === 'auto') {
        protocol = this.host.includes('localhost') || this.host.includes('127.0.0.1') ? 'http' : 'https';
      }
      return `${protocol}://${this.host}:${this.httpPort}`;
    }
  },
  
  // JWT
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-this',
  
  // FFmpeg
  ffmpeg: {
    path: process.env.FFMPEG_PATH || 'ffmpeg',
    probePath: process.env.FFPROBE_PATH || 'ffprobe'
  }
};

