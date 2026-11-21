// Read-only live capture + hardware encode measurement. No video is retained.
// Distinct desktop updates remain limited by each physical monitor's refresh.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPowerShellBridge } from '../server.js';
import { createFFmpegVideoFactory, ffmpegArguments } from '../video-stream.js';

const executable = process.env.REMOTE_FFMPEG || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'ffmpeg.exe');
const bridge = createPowerShellBridge();
let desktop;
try { desktop = (await bridge.send('dimensions')).data; } finally { bridge.close(); }
const factory = createFFmpegVideoFactory({ executable });
const capabilities = { ...await factory.initialize({ screen: desktop, displays: desktop.displays }) };
factory.close();
if (!capabilities.available) throw new Error(capabilities.reason || 'Video encoder unavailable');

for (const profileId of ['balanced', 'native']) {
  const args = ffmpegArguments({ profileId, fps: 90, screen: desktop,
    encoder: capabilities.encoder, capture: capabilities.capture, displays: desktop.displays });
  args.splice(args.indexOf('-an'), 0, '-t', '8', '-progress', 'pipe:2', '-stats_period', '1');
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let bytes = 0;
  let pending = '';
  let warnings = '';
  let sample = {};
  const points = [];
  const start = performance.now();
  child.stdout.on('data', (chunk) => { bytes += chunk.length; });
  child.stderr.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const match = /^([a-z_0-9]+)=(.*)$/.exec(line.trim());
      if (!match) { warnings = (warnings + '\n' + line).slice(-4000); continue; }
      sample[match[1]] = match[2];
      if (match[1] === 'progress') { points.push({ ...sample, wallMs: performance.now() - start }); sample = {}; }
    }
  });
  const timeout = setTimeout(() => child.kill(), 20_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout);
  const first = points.find((point) => point.wallMs > 1500) || points[0];
  const last = points.at(-1);
  const stableSeconds = first && last ? (last.wallMs - first.wallMs) / 1000 : 0;
  console.log(JSON.stringify({ profile: profileId, targetFps: 90, code,
    encoder: capabilities.encoder, capture: capabilities.capture,
    wallMs: Math.round(performance.now() - start), framesAtMuxer: Number(last?.frame || 0), bytes,
    steadyOutputFps: stableSeconds > 0 ? Number(((Number(last.frame) - Number(first.frame)) / stableSeconds).toFixed(1)) : null,
    duplicatedFramesAtMuxer: Number(last?.dup_frames || 0), droppedFramesAtMuxer: Number(last?.drop_frames || 0),
    note: 'Output delivery measurement, not proof of distinct changes in every captured frame. DXGI may repeat unchanged content and the fps filter synchronizes independent monitor timestamps. Physical displays and mobile rendering can limit visible refresh. No desktop video is saved and no keyboard or mouse input is sent.',
    warnings }, null, 2));
  if (code !== 0) throw new Error('Video probe failed');
}
