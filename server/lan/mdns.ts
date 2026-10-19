import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { ioMode } from "../mode";

let socket: Socket | null = null;

export function lanIPv4(): string | null {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.internal || net.family !== "IPv4") continue;
      const address = net.address;
      if (address.startsWith("10.") || address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
        return address;
      }
    }
  }
  return null;
}

export function mdnsName(): string {
  return (process.env.IO_MDNS_NAME || "io").trim().replace(/\.local$/i, "") || "io";
}

function encodeName(host: string): Buffer {
  const labels = [host, "local"];
  return Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
}

/** One A answer for host.local. Used by the announcer and by tests. */
export function mdnsAnswer(host: string, ip: string): Buffer {
  const name = encodeName(host);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  const suffix = Buffer.alloc(10);
  suffix.writeUInt16BE(1, 0);
  suffix.writeUInt16BE(0x8001, 2);
  suffix.writeUInt32BE(120, 4);
  suffix.writeUInt16BE(4, 8);
  const rdata = Buffer.from(ip.split(".").map((part) => Number(part)));
  return Buffer.concat([header, name, suffix, rdata]);
}

function asksFor(packet: Buffer, host: string): boolean {
  return packet.includes(encodeName(host));
}

export function startMdns() {
  if (socket || process.env.IO_MDNS === "0" || ioMode() !== "local-relay") return;
  const ip = lanIPv4();
  if (!ip) return;
  const host = mdnsName();
  try {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", () => {
      // Multicast can fail on a locked-down NIC. The fixed LAN address still works.
    });
    sock.on("message", (msg, rinfo) => {
      if (!asksFor(msg, host)) return;
      try {
        sock.send(mdnsAnswer(host, ip), rinfo.port, rinfo.address);
      } catch {
        // Ignore a send failure. The next query can answer.
      }
    });
    sock.bind(5353, () => {
      try {
        sock.addMembership("224.0.0.251");
      } catch {
        // Unicast answers still go out if the group join is refused.
      }
      try {
        sock.send(mdnsAnswer(host, ip), 5353, "224.0.0.251");
      } catch {
        // A fixed LAN_BASE_URL does not need the announcement.
      }
    });
    sock.unref();
    socket = sock;
  } catch {
    socket = null;
  }
}

export function stopMdns() {
  const current = socket;
  socket = null;
  if (!current) return;
  try {
    current.close();
  } catch {
    // Already closed.
  }
}
