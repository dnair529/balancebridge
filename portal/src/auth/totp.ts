import { authenticator } from 'otplib';
import QRCode from 'qrcode';

// RFC 6238, 30s step, accept ±1 step of clock drift per spec.
authenticator.options = { window: 1 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function verifyTotp(secret: string, code: string): boolean {
  const trimmed = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    return authenticator.verify({ secret, token: trimmed });
  } catch {
    return false;
  }
}

/** otpauth:// URI rendered as a QR data URL for the settings page. */
export async function totpQrDataUrl(email: string, secret: string): Promise<string> {
  const uri = authenticator.keyuri(email, 'Balance Bridge Portal', secret);
  return QRCode.toDataURL(uri, { margin: 1, width: 220 });
}
