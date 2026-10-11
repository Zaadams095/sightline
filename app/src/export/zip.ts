/**
 * Minimal "stored" (uncompressed) zip writer, used when the tunnel library's Go zipper isn't in
 * the app (older builds). Videos and JPEGs don't compress, so storing is the right choice
 * anyway. No ZIP64: callers keep the total under ZIP_MAX_BYTES. Pure, so it's unit-tested.
 */

export const ZIP_MAX_BYTES = 0xfffffffe - 10_000_000;

export interface ZipEntry {
  /** Path inside the archive ("Sightline export/video/front.mp4"). */
  name: string;
  size: number;
  crc: number;
  /** DOS time of the entry (local time of the export). */
  date: Date;
}

export interface ZipSink {
  write(bytes: Uint8Array): void;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class Bytes {
  private parts: number[] = [];
  u16(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  raw(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

const FLAG_UTF8 = 1 << 11;

/** The header written before an entry's data. */
export function localHeader(e: ZipEntry): Uint8Array {
  const name = new TextEncoder().encode(e.name);
  const { time, date } = dosTime(e.date);
  return new Bytes()
    .u32(0x04034b50)
    .u16(20)
    .u16(FLAG_UTF8)
    .u16(0) // stored
    .u16(time)
    .u16(date)
    .u32(e.crc)
    .u32(e.size)
    .u32(e.size)
    .u16(name.length)
    .u16(0)
    .raw(name)
    .done();
}

function centralHeader(e: ZipEntry, offset: number): Uint8Array {
  const name = new TextEncoder().encode(e.name);
  const { time, date } = dosTime(e.date);
  return new Bytes()
    .u32(0x02014b50)
    .u16(20)
    .u16(20)
    .u16(FLAG_UTF8)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(e.crc)
    .u32(e.size)
    .u32(e.size)
    .u16(name.length)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(0)
    .u32(offset)
    .raw(name)
    .done();
}

/**
 * Writes a zip: for each entry, its local header, then `writeData(i)` must write exactly
 * entry.size bytes to the sink, then the central directory. Returns the total size.
 */
export async function writeZip(entries: ZipEntry[], sink: ZipSink, writeData: (index: number) => Promise<void>): Promise<number> {
  let offset = 0;
  const offsets: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    offsets.push(offset);
    const h = localHeader(entries[i]);
    sink.write(h);
    await writeData(i);
    offset += h.length + entries[i].size;
  }
  const cdStart = offset;
  for (let i = 0; i < entries.length; i++) {
    const c = centralHeader(entries[i], offsets[i]);
    sink.write(c);
    offset += c.length;
  }
  const end = new Bytes()
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(entries.length)
    .u16(entries.length)
    .u32(offset - cdStart)
    .u32(cdStart)
    .u16(0)
    .done();
  sink.write(end);
  return offset + end.length;
}
