import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
// This fixture is deliberately restricted to localhost and synthetic .test recipients.
import { SMTPServer } from "smtp-server";

const caFile = fileURLToPath(new URL("../fixtures/mail-smtp-test-ca.pem", import.meta.url));
const keyFile = fileURLToPath(new URL("../fixtures/mail-smtp-test-key.pem", import.meta.url));

export async function startLocalTlsSmtpSink() {
  const [cert, key] = await Promise.all([readFile(caFile), readFile(keyFile)]);
  const credentials = { username: "teamshelf-e2e", password: "e2e-" + randomUUID() + "-" + randomUUID() };
  const received = [];
  let rejectAuth = false;
  const server = new SMTPServer({
    secure: true,
    key,
    cert,
    name: "localhost",
    banner: "TeamShelf isolated E2E mail sink",
    hideSTARTTLS: true,
    authOptional: false,
    logger: false,
    onAuth(auth, _session, callback) {
      if (rejectAuth || auth.username !== credentials.username || auth.password !== credentials.password) {
        const error = new Error("E2E SMTP authentication rejected");
        error.responseCode = 535;
        callback(error);
        return;
      }
      callback(null, { user: credentials.username });
    },
    onRcptTo(address, _session, callback) {
      if (!address.address.toLowerCase().endsWith(".test")) {
        const error = new Error("E2E sink only accepts synthetic .test recipients");
        error.responseCode = 550;
        callback(error);
        return;
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom?.address ?? "",
          to: session.envelope.rcptTo.map(recipient => recipient.address),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        callback(null, "captured by isolated test sink");
      });
    },
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    await new Promise(resolve => server.close(resolve));
    throw new Error("Could not bind isolated SMTP sink");
  }

  return {
    host: "127.0.0.1",
    port: address.port,
    ...credentials,
    received,
    set rejectAuth(value) { rejectAuth = value; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

export function inviteUrlFromMail(mail) {
  // Nodemailer wraps quoted-printable MIME lines; undo soft breaks and =XX escapes first.
  const decoded = mail.raw
    .replace(/=\r?\n/g, "")
    .replace(/=([A-Fa-f0-9]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  const candidate = decoded.match(/https?:\/\/[^\s<>"']+\?invite=[A-Za-z0-9_-]+/u)?.[0];
  if (!candidate) throw new Error("Captured E2E email did not contain an invitation URL");
  return candidate.replace(/[),.;]+$/u, "");
}