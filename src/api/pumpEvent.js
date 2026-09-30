/**
 * Decode Pump.fun's CreateEvent straight from the transaction LOGS — no getTransaction call.
 *
 * Pump.fun emits an Anchor event as a log line: "Program data: <base64>".
 * CreateEvent layout (Borsh):  8-byte discriminator | name | symbol | uri (each u32 len + utf8)
 *                              | mint (32) | bondingCurve (32) | user (32) | ...
 *
 * SELF-CHECK: the decoded bondingCurve must equal the PDA derived from the decoded mint. If
 * Pump.fun ever changes the layout, that check fails, decode returns null, and the scanner
 * falls back to the getTransaction path — a layout change can never yield a wrong mint.
 *
 * I could not test this against a live transaction from my sandbox: the discriminator and
 * field order are from memory of the Pump.fun IDL. The bot logs which path it is using.
 */
const { PublicKey } = require('@solana/web3.js');
const { PUMP_FUN_PROGRAM } = require('./pumpfun');

const CREATE_EVENT_DISC = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const PREFIX = 'Program data: ';

function readString(buf, off) {
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32LE(off);
  if (len > 256 || off + 4 + len > buf.length) return null;
  return { value: buf.toString('utf8', off + 4, off + 4 + len), next: off + 4 + len };
}

function decodeCreateEvent(logs) {
  for (const line of logs || []) {
    const i = line.indexOf(PREFIX);
    if (i < 0) continue;
    let buf;
    try { buf = Buffer.from(line.slice(i + PREFIX.length).trim(), 'base64'); } catch { continue; }
    if (buf.length < 8 + 12 + 96 || !buf.subarray(0, 8).equals(CREATE_EVENT_DISC)) continue;

    let off = 8; const parts = [];
    for (let k = 0; k < 3; k++) {
      const r = readString(buf, off);
      if (!r) break;
      parts.push(r.value); off = r.next;
    }
    if (parts.length < 3 || off + 96 > buf.length) continue;

    try {
      const mint = new PublicKey(buf.subarray(off, off + 32));
      const curve = new PublicKey(buf.subarray(off + 32, off + 64));
      const user = new PublicKey(buf.subarray(off + 64, off + 96));
      const expected = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBytes()], PUMP_FUN_PROGRAM)[0];
      if (!expected.equals(curve)) continue;                                   // layout drift => refuse
      return { name: parts[0], symbol: parts[1], uri: parts[2],
               mint: mint.toBase58(), bondingCurve: curve.toBase58(), creator: user.toBase58() };
    } catch { continue; }
  }
  return null;
}

module.exports = { decodeCreateEvent, CREATE_EVENT_DISC };
