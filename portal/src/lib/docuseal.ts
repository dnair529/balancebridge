import { config } from '../config.js';

/**
 * Minimal DocuSeal API client (self-hosted instance at DOCUSEAL_URL).
 * Auth is the X-Auth-Token API key. All calls are server-to-server.
 */

export function docusealConfigured(): boolean {
  return Boolean(config.DOCUSEAL_URL && config.DOCUSEAL_API_KEY);
}

async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.DOCUSEAL_URL}/api${pathname}`, {
    ...init,
    headers: {
      'X-Auth-Token': config.DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`DocuSeal API ${pathname} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

interface DocusealSubmitter {
  slug?: string;
  email?: string;
}

/**
 * Create a template from a PDF, then a submission for one signer.
 * Returns the submission id (stored on signature_requests).
 * We deliberately do NOT let DocuSeal email the signer — the portal sends
 * its own branded notification.
 */
export async function createSubmissionFromPdf(input: {
  title: string;
  pdfBase64: string;
  signerEmail: string;
  signerName?: string;
}): Promise<{ submissionId: string }> {
  const template = await api<{ id: number }>(`/templates/pdf`, {
    method: 'POST',
    body: JSON.stringify({
      name: input.title,
      documents: [{ name: input.title, file: input.pdfBase64 }],
    }),
  });

  const submission = await api<{ id: number } | Array<{ submission_id?: number; id?: number }>>(
    `/submissions`,
    {
      method: 'POST',
      body: JSON.stringify({
        template_id: template.id,
        send_email: false,
        submitters: [{ email: input.signerEmail, name: input.signerName, role: 'First Party' }],
      }),
    },
  );

  // The API historically returned either the submission or its submitters.
  const submissionId = Array.isArray(submission)
    ? String(submission[0]?.submission_id ?? submission[0]?.id ?? '')
    : String(submission.id);
  if (!submissionId) throw new Error('DocuSeal did not return a submission id');
  return { submissionId };
}

/** Signing-page slug for the given signer, used for the iframe embed URL. */
export async function getSignerSlug(submissionId: string, signerEmail: string): Promise<string | null> {
  const submission = await api<{ submitters?: DocusealSubmitter[] }>(`/submissions/${submissionId}`);
  const submitter =
    submission.submitters?.find((s) => s.email?.toLowerCase() === signerEmail.toLowerCase()) ??
    submission.submitters?.[0];
  return submitter?.slug ?? null;
}

/** Download the combined signed PDF for a completed submission. */
export async function fetchSignedPdf(submissionId: string): Promise<Buffer | null> {
  const docs = await api<{ documents?: Array<{ url?: string }> } | Array<{ url?: string }>>(
    `/submissions/${submissionId}/documents`,
  ).catch(() => null);
  const url = Array.isArray(docs) ? docs[0]?.url : docs?.documents?.[0]?.url;
  if (!url) return null;
  const res = await fetch(url, { headers: { 'X-Auth-Token': config.DOCUSEAL_API_KEY } });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}
