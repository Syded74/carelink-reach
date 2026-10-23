'use strict';
/*
  Cuts the recorded workflow clips (clips/workflow, from record-flow.js) to their app content and joins them in
  order into final/CareLink_Reach_App_Workflow.mp4 (npm run build-flow). App screen only: no captions, panels or
  narration. Needs ffmpeg on the PATH.
*/
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLIPS = path.join(__dirname, 'clips', 'workflow');
const PARTS = path.join(CLIPS, 'parts');
const OUT = path.join(__dirname, 'final', 'CareLink_Reach_App_Workflow.mp4');
const timings = JSON.parse(fs.readFileSync(path.join(CLIPS, 'timings.json'), 'utf8'));
fs.mkdirSync(PARTS, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const parts = [];
for (const id of Object.keys(timings).sort()) {
  timings[id].forEach(([from, to], i) => {
    const part = path.join(PARTS, `${id}-${i}.mp4`);
    ffmpeg(['-i', path.join(CLIPS, `${id}.webm`), '-ss', from.toFixed(2), '-to', to.toFixed(2),
      '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-an', part]);
    parts.push(part);
  });
}
const list = path.join(PARTS, 'list.txt');
fs.writeFileSync(list, parts.map(p => `file '${p}'`).join('\n') + '\n');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', OUT]);
const seconds = Object.values(timings).flat().reduce((s, [a, b]) => s + b - a, 0);
console.log(`✔ ${path.relative(__dirname, OUT)} · ${parts.length} cuts · about ${Math.round(seconds)} s`);
