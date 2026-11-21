// Capture-only benchmark. Does not save images or send mouse/keyboard input.
import { performance } from 'node:perf_hooks';
import { createPowerShellBridge, SCREEN_PROFILES } from '../server.js';

if (process.platform !== 'win32') throw new Error('此测速脚本需要 Windows 桌面。');
const bridge = createPowerShellBridge();
try {
  const { data: screen } = await bridge.send('dimensions');
  const measurements = [];
  for (const [id, profile] of Object.entries(SCREEN_PROFILES)) {
    for (let warmup = 0; warmup < 2; warmup++) await bridge.send('screen', profile);
    const elapsed = [];
    let totalBytes = 0;
    for (let frame = 0; frame < 12; frame++) {
      const start = performance.now();
      const result = await bridge.send('screen', profile);
      elapsed.push(performance.now() - start);
      totalBytes += Buffer.from(result.data, 'base64').length;
    }
    const averageMs = elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length;
    const ratio = Math.min(1, profile.maxWidth / screen.width, profile.maxHeight / screen.height);
    const averageBytes = totalBytes / elapsed.length;
    measurements.push({
      profile: id,
      resolution: `${Math.round(screen.width * ratio)} × ${Math.round(screen.height * ratio)}`,
      jpegQuality: profile.quality,
      averageCaptureMs: Number(averageMs.toFixed(1)),
      captureFramesPerSecond: Number((1000 / averageMs).toFixed(1)),
      averageFrameKB: Math.round(averageBytes / 1024),
      estimatedMbpsAt20Fps: Number((averageBytes * 20 * 8 / 1_000_000).toFixed(1)),
    });
  }
  console.log(JSON.stringify({ screen, framesPerProfile: 12, measurements }, null, 2));
  console.log('这是当前桌面内容的采集测速，不包含网络传输或手机解码时间；动态画面耗时与流量可能不同。');
} finally { bridge.close(); }
