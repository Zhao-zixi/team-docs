export interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
}
export interface LocalTlsSmtpSink {
  host: "127.0.0.1";
  port: number;
  username: string;
  password: string;
  received: CapturedMail[];
  rejectAuth: boolean;
  close(): Promise<void>;
}
export function startLocalTlsSmtpSink(): Promise<LocalTlsSmtpSink>;
export function inviteUrlFromMail(mail: CapturedMail): string;