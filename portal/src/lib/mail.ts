import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

let transporter: Transporter;

if (config.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
} else {
  // Dev fallback: render the message as JSON and log it — no network.
  transporter = nodemailer.createTransport({ jsonTransport: true });
}

interface MailInput {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail(input: MailInput): Promise<void> {
  try {
    const info = await transporter.sendMail({
      from: config.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    if (!config.SMTP_HOST) {
      console.log('[mail:console]', JSON.stringify({ to: input.to, subject: input.subject }));
      if (config.isDev) console.log(info.message);
    }
  } catch (err) {
    // Email is best-effort; never fail a user action because SMTP hiccuped.
    console.error('[mail] send failed:', err);
  }
}

// ---- Plain-English templates (brand voice: short, direct, no jargon) ----

export function inviteEmail(link: string, invitedBy: string): Pick<MailInput, 'subject' | 'text'> {
  return {
    subject: 'Your Balance Bridge portal invite',
    text: `${invitedBy} invited you to the Balance Bridge client portal.

Set up your account here (link expires in 7 days):
${link}

If you weren't expecting this, you can ignore it.

— Balance Bridge Financial`,
  };
}

export function resetEmail(link: string): Pick<MailInput, 'subject' | 'text'> {
  return {
    subject: 'Reset your portal password',
    text: `Someone asked to reset the password for your Balance Bridge portal account.

Reset it here (link expires in 1 hour):
${link}

If that wasn't you, ignore this email — your password is unchanged.

— Balance Bridge Financial`,
  };
}

export function newMessageEmail(subject: string, link: string): Pick<MailInput, 'subject' | 'text'> {
  return {
    subject: `New message: ${subject}`,
    text: `You have a new message in the Balance Bridge portal.

Thread: ${subject}
Read and reply here: ${link}

— Balance Bridge Financial`,
  };
}

export function signatureRequestEmail(title: string, link: string): Pick<MailInput, 'subject' | 'text'> {
  return {
    subject: `Signature needed: ${title}`,
    text: `A document is ready for your signature in the Balance Bridge portal.

Document: ${title}
Sign it here: ${link}

— Balance Bridge Financial`,
  };
}

export function taskAssignedEmail(title: string, link: string): Pick<MailInput, 'subject' | 'text'> {
  return {
    subject: 'New checklist in your portal',
    text: `We added a checklist for you in the Balance Bridge portal.

Checklist: ${title}
See what's needed: ${link}

— Balance Bridge Financial`,
  };
}

export function leadAlertEmail(lead: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  businessType?: string | null;
  revenue?: string | null;
  message?: string | null;
  form: string;
}): Pick<MailInput, 'subject' | 'text'> {
  return {
    subject: `New lead: ${lead.name || lead.email || 'website form'}`,
    text: `New lead from the ${lead.form} form on balancebridge.us.

Name: ${lead.name ?? '-'}
Email: ${lead.email ?? '-'}
Phone: ${lead.phone ?? '-'}
Company: ${lead.company ?? '-'}
Business type: ${lead.businessType ?? '-'}
Revenue: ${lead.revenue ?? '-'}

Message:
${lead.message ?? '-'}`,
  };
}
