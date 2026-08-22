// Correct GIF frame extraction: every frame in these files is full-canvas with
// disposal=2 (restore to background), so each one must be decoded onto a CLEARED
// buffer. Blitting cumulatively stacks every frame on top of the last, which both
// looked wrong on screen and inflated every area/blob number measured that way.
const { GifReader } = require('E:/Projects/skoolclass-pro/node_modules/omggif');
const fs = require('fs');

function readFrames(path) {
  const r = new GifReader(fs.readFileSync(path));
  const n = r.width * r.height * 4;
  const out = [];
  let prev = null;
  for (let i = 0; i < r.numFrames(); i++) {
    const info = r.frameInfo(i);
    // disposal 0/1 = leave the previous pixels in place; 2/3 = start clean
    const buf = new Uint8Array(n);
    if (prev && (info.disposal === 0 || info.disposal === 1)) buf.set(prev);
    r.decodeAndBlitFrameRGBA(i, buf);
    out.push(buf);
    prev = buf;
  }
  return { w: r.width, h: r.height, frames: out, info: r.frameInfo(0) };
}

module.exports = { readFrames };
