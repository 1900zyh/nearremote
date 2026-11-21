// Temporary-to-memory capture tests. No desktop video is saved and no input is sent.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'ffmpeg.exe');
const mode = process.argv[2] || 'combined';
const inputs = {
  combined: [
    'ddagrab=output_idx=0:framerate=60:draw_mouse=0,hwdownload,format=bgra,setpts=PTS-STARTPTS,scale=960:600:flags=fast_bilinear[a]',
    'ddagrab=output_idx=1:framerate=60:draw_mouse=0,hwdownload,format=bgra,setpts=PTS-STARTPTS,scale=960:540:flags=fast_bilinear,pad=960:600:0:0:black[b]',
    '[a][b]hstack=inputs=2,fps=60,format=nv12[out]',
  ].join(';'),
  'combined-native': [
    'ddagrab=output_idx=0:framerate=60:draw_mouse=0,hwdownload,format=bgra,setpts=PTS-STARTPTS[a]',
    'ddagrab=output_idx=1:framerate=60:draw_mouse=0,hwdownload,format=bgra,setpts=PTS-STARTPTS,pad=1920:1200:0:0:black[b]',
    '[a][b]hstack=inputs=2,fps=60,format=nv12[out]',
  ].join(';'),
  primary: 'ddagrab=output_idx=0:framerate=60:draw_mouse=0,hwdownload,format=bgra,setpts=PTS-STARTPTS,scale=1728:1080:flags=fast_bilinear,format=nv12[out]',
};
if (!Object.hasOwn(inputs, mode)) throw new Error('Use combined, combined-native, or primary');
const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-filter_complex', inputs[mode], '-map', '[out]',
  '-t', '7', '-an', '-c:v', 'h264_mf', '-hw_encoding', '1', '-scenario', 'display_remoting', '-rate_control', 'ld_vbr',
  '-b:v', mode === 'combined-native' ? '36M' : '12M', '-g', '30', '-bf', '0', '-fps_mode', 'passthrough',
  '-movflags', '+frag_every_frame+empty_moov+default_base_moof+omit_tfhd_offset', '-flush_packets', '1',
  '-progress', 'pipe:2', '-stats_period', '1', '-f', 'mp4', 'pipe:1'];
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
console.log(JSON.stringify({ mode, code, wallMs: Math.round(performance.now() - start), bytes,
  steadyOutputFps: stableSeconds > 0 ? Number(((Number(last.frame) - Number(first.frame)) / stableSeconds).toFixed(1)) : null,
  framesAtMuxer: Number(last?.frame || 0),
  note: 'This measures current desktop capture and encode delivery, not distinct changes in static desktop content. ddagrab can repeat an unchanged desktop frame at the requested sampling rate. The final fps filter synchronizes independently timestamped displays; no optical-flow interpolation is used. Network and mobile decoding are not measured.',
  points, warnings }, null, 2));
if (code) process.exitCode = 1;
