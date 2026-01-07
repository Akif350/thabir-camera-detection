require('dotenv').config();

// Helper function to clean environment variables (remove quotes if present)
const cleanEnv = (value) => {
  if (!value) return value;
  const cleaned = value.toString().trim();
  // Remove surrounding quotes if present
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || 
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    return cleaned.slice(1, -1);
  }
  return cleaned;
};

module.exports = {
  // Server
  port: process.env.PORT || 9001,
  nodeEnv: cleanEnv(process.env.NODE_ENV) || 'development',
  baseUrl: cleanEnv(process.env.BASE_URL) || (process.env.NODE_ENV === 'production' 
    ? 'https://thabir-camera-detection-production.up.railway.app' 
    : `http://localhost:${process.env.PORT || 9001}`),
  
  // Database
  mongodbUri: cleanEnv(process.env.MONGODB_URI) || 'mongodb://localhost:27017/thabir',
  
  // External API
  baseApiUrl: cleanEnv(process.env.BASE_API_URL) || 'http://127.0.0.1:8000',
  apiLoginUrl: cleanEnv(process.env.API_LOGIN_URL) || 'http://127.0.0.1:8000/api/auth/token/',
  cameraApiBaseUrl: cleanEnv(process.env.CAMERA_API_BASE_URL) || 'http://127.0.0.1:8000/api/workspace/',
  
  // MediaMTX
  mediamtx: {
    host: cleanEnv(process.env.MEDIAMTX_HOST) || 'cctv.thabir.ai',
    rtspPort: parseInt(cleanEnv(process.env.MEDIAMTX_RTSP_PORT)) || 8554,
    httpPort: parseInt(cleanEnv(process.env.MEDIAMTX_HTTP_PORT)) || 8888,
    protocol: cleanEnv(process.env.MEDIAMTX_PROTOCOL) || 'http', // http or https
    user: cleanEnv(process.env.MEDIAMTX_USER) || '',
    pass: cleanEnv(process.env.MEDIAMTX_PASS) || '',
    getPushBase() {
      if (this.user && this.pass) {
        return `rtsp://${this.user}:${this.pass}@${this.host}:${this.rtspPort}`;
      }
      return `rtsp://${this.host}:${this.rtspPort}`;
    },
    getPublicBase() {
      // Use explicit protocol from env, default to http if not specified
      let protocol = this.protocol || 'http';
      // Only use https if explicitly set to 'https', otherwise use http
      if (protocol !== 'https') {
        protocol = 'http';
      }
      return `${protocol}://${this.host}:${this.httpPort}`;
    }
  },
  
  // JWT
  jwtSecret: cleanEnv(process.env.JWT_SECRET) || 'your-secret-key-change-this',
  
  // FFmpeg
  ffmpeg: {
    path: cleanEnv(process.env.FFMPEG_PATH) || 'ffmpeg',
    probePath: cleanEnv(process.env.FFPROBE_PATH) || 'ffprobe'
  }
};

