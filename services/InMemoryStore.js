class InMemoryStore {
  constructor() {
    this.cameras = new Map(); // streamName -> camera-like object
  }

  upsertCamera(cam) {
    if (!cam?.streamName) return null;
    const existing = this.cameras.get(cam.streamName) || {};
    const merged = { ...existing, ...cam };
    this.cameras.set(cam.streamName, merged);
    return merged;
  }

  listCameras({ workspaceId } = {}) {
    const all = Array.from(this.cameras.values());
    const filtered = workspaceId ? all.filter((c) => c.workspaceId === workspaceId) : all;
    return filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  getByStreamName(streamName) {
    return this.cameras.get(streamName) || null;
  }

  clear() {
    const count = this.cameras.size;
    this.cameras.clear();
    return count;
  }
}

module.exports = new InMemoryStore();

