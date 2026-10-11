/**
 * Streaming SHA-256 and CRC-32 in plain TypeScript. The tunnel library hashes and zips in Go
 * when it's in the app (much faster); these are the fallback and what the tests check against.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private block = new Uint8Array(64);
  private blockLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array): this {
    let i = 0;
    this.total += data.length;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array(this.blockLen < 56 ? 64 - this.blockLen : 128 - this.blockLen);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const n = pad.length;
    pad[n - 8] = hi >>> 24;
    pad[n - 7] = hi >>> 16;
    pad[n - 6] = hi >>> 8;
    pad[n - 5] = hi;
    pad[n - 4] = lo >>> 24;
    pad[n - 3] = lo >>> 16;
    pad[n - 2] = lo >>> 8;
    pad[n - 1] = lo;
    const total = this.total;
    this.update(pad);
    this.total = total;
    const out = new Uint8Array(32);
    for (let j = 0; j < 8; j++) {
      out[j * 4] = this.h[j] >>> 24;
      out[j * 4 + 1] = this.h[j] >>> 16;
      out[j * 4 + 2] = this.h[j] >>> 8;
      out[j * 4 + 3] = this.h[j];
    }
    return out;
  }

  hex(): string {
    return toHex(this.digest());
  }

  private compress(b: Uint8Array, off: number) {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const p = off + t * 4;
      w[t] = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b2, c, d, e, f, g, h] = this.h;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b2;
      b2 = a;
      a = (t1 + t2) | 0;
    }
    this.h[0] += a;
    this.h[1] += b2;
    this.h[2] += c;
    this.h[3] += d;
    this.h[4] += e;
    this.h[5] += f;
    this.h[6] += g;
    this.h[7] += h;
  }
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function sha256Hex(data: Uint8Array | string): string {
  return new Sha256().update(typeof data === 'string' ? utf8(data) : data).hex();
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Running CRC-32 (zip's checksum). Start with 0; feed chunks; the result is unsigned. */
export function crc32(data: Uint8Array, prev = 0): number {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Short, readable form of a fingerprint for print: "3F2A 91C0 … 7B11". */
export function shortFingerprint(hex: string): string {
  const h = hex.toUpperCase();
  if (h.length <= 16) return h.replace(/(.{4})(?=.)/g, '$1 ');
  return `${h.slice(0, 8).replace(/(.{4})/, '$1 ')} … ${h.slice(-8).replace(/(.{4})/, '$1 ')}`;
}
