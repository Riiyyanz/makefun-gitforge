// pkt-line framing for git smart HTTP (protocol v0 and v2).
// A data packet is 4 lowercase hex length bytes (payload + 4) followed by the payload;
// 0000 is a flush, 0001 a delim, 0002 a response-end (git's LARGE_PACKET_MAX is 65520).

export const PKT_MAX = 65520;
export const PKT_MAX_PAYLOAD = PKT_MAX - 4;

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const body = data.length > PKT_MAX_PAYLOAD ? data.subarray(0, PKT_MAX_PAYLOAD) : data;
  const head = Buffer.allocUnsafe(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body], body.length + 4);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

export type PktPacket = { data: Buffer } | { control: 0 | 1 | 2 };

/** Read one packet at `offset`; `null` when the buffer holds fewer bytes than the packet needs. */
export function readPkt(buf: Buffer, offset: number): { packet: PktPacket; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const lenHex = buf.toString('ascii', offset, offset + 4);
  const len = Number.parseInt(lenHex, 16);
  if (!Number.isFinite(len) || /[^0-9a-f]/i.test(lenHex)) return null;
  if (len === 0) return { packet: { control: 0 }, next: offset + 4 };
  if (len === 1) return { packet: { control: 1 }, next: offset + 4 };
  if (len === 2) return { packet: { control: 2 }, next: offset + 4 };
  if (len < 4) return null;
  if (offset + len > buf.length) return null;
  return { packet: { data: buf.subarray(offset + 4, offset + len) }, next: offset + len };
}

/** Decode every packet in `buf`; stops at the first incomplete packet and reports its offset. */
export function decodePkts(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  for (;;) {
    const read = readPkt(buf, offset);
    if (read === null) break;
    packets.push(read.packet);
    offset = read.next;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** The text of each data packet, newline-terminated lines kept as git sends them. */
export function dataLines(buf: Buffer): { lines: string[]; rest: Buffer; ended: boolean } {
  const { packets, rest } = decodePkts(buf);
  const lines: string[] = [];
  let ended = false;
  for (const packet of packets) {
    if ('control' in packet) {
      if (packet.control === 0) ended = true;
      continue;
    }
    lines.push(packet.data.toString('utf8'));
  }
  return { lines, rest, ended };
}
