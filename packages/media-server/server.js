const NodeMediaServer = require('node-media-server');

const config = {
  logType: 3,
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: 8080,
    allow_origin: '*',
    // Use absolute path to avoid cwd confusion
    mediaroot: '/app/media',
  },
  trans: {
    ffmpeg: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
    tasks: [
      {
        app: 'live',
        ac: 'aac',
        vc: 'libx264',
        // Enable HLS output; Node-Media-Server uses FFmpeg tee muxer internally
        hls: true,
        // Explicitly set f=hls to ensure tee writes HLS, and use reasonable flags
        // Keep a short live window; independent_segments improves compatibility
        hlsFlags: '[f=hls:hls_time=2:hls_list_size=6:hls_flags=delete_segments+independent_segments]'
      }
    ]
  }
};

const nms = new NodeMediaServer(config);

// Validate stream key and notify backend that stream went LIVE
nms.on('prePublish', async (id, StreamPath, args) => {
  const key = (StreamPath || '').split('/').pop();
  try {
    const base = process.env.API_BASE || 'http://backend:8000/api';
    const resp = await fetch(`${base}/nms/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = resp.ok ? await resp.json().catch(() => ({ ok: false })) : { ok: false };
    if (!key || !resp.ok || !data.ok) {
      const session = nms.getSession(id);
      session && session.reject();
    }
  } catch (e) {
    const session = nms.getSession(id);
    session && session.reject();
  }
});

// Notify backend when stream stops
nms.on('donePublish', async (id, StreamPath, args) => {
  const key = (StreamPath || '').split('/').pop();
  try {
    const base = process.env.API_BASE || 'http://backend:8000/api';
    await fetch(`${base}/nms/unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
  } catch {
    // noop
  }
});

nms.run();
