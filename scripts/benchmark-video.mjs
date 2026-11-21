// Measures live desktop capture + encode + pipe delivery without retaining video.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createFFmpegVideoFactory, ffmpegArguments } from '../video-stream.js';
import { createPowerShellBridge } from '../server.js';

if (process.platform !== 'win32') throw new Error('此测速需要 Windows 活动桌面。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.REMOTE_FFMPEG || path.join(root, 'tools', 'ffmpeg.exe');
const targetFps = Number(process.env.VIDEO_TEST_FPS || 60);
if (![30, 60, 90].includes(targetFps)) throw new Error('VIDEO_TEST_FPS must be 30, 60, or 90');
await fs.access(executable);
const bridge = createPowerShellBridge();
let screen;
try { screen = (await bridge.send('dimensions')).data; } finally { bridge.close(); }
const factory = createFFmpegVideoFactory({ executable });
const capabilities = { ...await factory.initialize({ screen, displays: screen.displays }) };
factory.close();
if (!capabilities.available) throw new Error('没有可用的视频编码器。');
const profiles = process.argv.includes('--all') ? ['balanced', 'sharp', 'native'] : ['balanced'];
for (const profileId of profiles) {
  const args = ffmpegArguments({ profileId, fps: targetFps, screen, encoder: capabilities.encoder, capture: capabilities.capture, displays: screen.displays });
  args.splice(args.indexOf('-an'), 0, '-t', '10', '-progress', 'pipe:2', '-stats_period', '0.5');
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0;
  let pending = '';
  let warnings = '';
  let sample = {};
  const points = [];
  const start = performance.now();
  child.stdout.on('data', (chunk) => { bytes += chunk.length; });
  child.stderr.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const match = /^([a-z_0-9]+)=(.*)$/.exec(line.trim());
      if (!match) { warnings = (warnings + '\n' + line).slice(-2000); continue; }
      sample[match[1]] = match[2];
      if (match[1] === 'progress') { points.push({ ...sample, elapsedMs: performance.now() - start }); sample = {}; }
    }
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  if (code !== 0) throw new Error(`视频测速未完成 (${code}): ${warnings}`);
  const first = points.find((point) => point.elapsedMs > 1500) || points[0];
  const last = points.at(-1);
  const seconds = (last.elapsedMs - first.elapsedMs) / 1000;
  const deliveredFrames = Number(last.frame) - Number(first.frame);
  const duplicatedFrames = Number(last.dup_frames || 0) - Number(first.dup_frames || 0);
  console.log(JSON.stringify({ profile: profileId, desktop: screen, targetFps,
    measuredSeconds: Number(seconds.toFixed(2)), deliveredFramesPerSecond: Number((deliveredFrames / seconds).toFixed(1)),
    framesExcludingDuplicatesPerSecond: Number(((deliveredFrames - duplicatedFrames) / seconds).toFixed(1)),
    duplicatedFrames, approximateMbps: Number((bytes * 8 / (performance.now() - start) / 1000).toFixed(1)),
  }, null, 2));
}
console.log('这里只测电脑端采集、编码和输出，不包含手机 Wi-Fi 与视频解码。');
