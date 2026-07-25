import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { requireAuth, resolveClientId, isStaff } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import {
  saveStream,
  openStored,
  deleteStored,
  isAllowedExtension,
  FileTooLargeError,
} from '../lib/storage.js';
import { verifyCsrfValue } from '../lib/csrf.js';

const FOLDERS = ['General', 'Bank statements', 'Receipts', 'Payroll', 'Tax', 'Reports'];

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/documents', { preHandler: requireAuth }, async (req, reply) => {
    const clientId = resolveClientId(req);
    if (!clientId) return reply.redirect(isStaff(req) ? '/admin' : '/login', 303);

    const rows = await db.query.documents.findMany({
      where: and(eq(documents.clientId, clientId), isNull(documents.deletedAt)),
      orderBy: desc(documents.createdAt),
    });

    return reply.viewPage('documents.eta', {
      title: 'Documents',
      docs: rows,
      folders: FOLDERS,
      clientId,
    });
  });

  /**
   * Multipart upload. The global CSRF hook can't read multipart bodies, so
   * the route is marked skipCsrf and validates the _csrf part itself.
   */
  app.post(
    '/documents/upload',
    { preHandler: requireAuth, config: { skipCsrf: true } },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect('/admin', 303);

      let csrfValue: string | null = null;
      let folder = 'General';
      let stored: Awaited<ReturnType<typeof saveStream>> | null = null;
      let filename = '';
      let mime = 'application/octet-stream';

      try {
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            if (part.fieldname === '_csrf') csrfValue = String(part.value);
            if (part.fieldname === 'folder' && FOLDERS.includes(String(part.value))) {
              folder = String(part.value);
            }
          } else if (part.type === 'file' && !stored) {
            filename = part.filename ?? 'upload';
            mime = part.mimetype || 'application/octet-stream';
            if (!isAllowedExtension(filename)) {
              part.file.resume(); // drain
              return reply
                .flash('error', 'That file type isn’t supported. PDF, images, spreadsheets, and QuickBooks files are.')
                .redirect('/documents', 303);
            }
            stored = await saveStream(part.file);
          } else if (part.type === 'file') {
            part.file.resume(); // only the first file is accepted
          }
        }
      } catch (err) {
        if (err instanceof FileTooLargeError || (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.flash('error', 'Files are limited to 25MB.').redirect('/documents', 303);
        }
        throw err;
      }

      // Multipart CSRF check happens after parsing but before any DB write.
      if (!verifyCsrfValue(req, csrfValue)) {
        if (stored) await deleteStored(stored.storedName);
        return reply.code(403).viewPage('error.eta', {
          title: 'Form expired',
          message: 'That form expired or was tampered with. Go back and try again.',
        });
      }
      if (!stored) {
        return reply.flash('error', 'Pick a file to upload first.').redirect('/documents', 303);
      }

      const [doc] = await db
        .insert(documents)
        .values({
          clientId,
          uploadedBy: req.authContext!.user.id,
          folder,
          filename: filename.slice(0, 300),
          storedName: stored.storedName,
          mime: mime.slice(0, 200),
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
        })
        .returning();

      await audit(req, {
        action: 'document.upload',
        clientId,
        entity: 'document',
        entityId: doc!.id,
        meta: { filename: doc!.filename, sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
      });

      const dest = isStaff(req) ? `/documents?client=${clientId}` : '/documents';
      return reply.flash('ok', `Uploaded ${doc!.filename}.`).redirect(dest, 303);
    },
  );

  /** Authenticated streaming download — attachment + nosniff (spec §5). */
  app.get<{ Params: { id: string } }>(
    '/documents/:id/download',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect('/admin', 303);

      // Scoped lookup: id alone is never enough — client_id must match too.
      const doc = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, req.params.id),
          eq(documents.clientId, clientId),
          isNull(documents.deletedAt),
        ),
      });
      if (!doc) {
        return reply.code(404).viewPage('error.eta', { title: 'Not found', message: 'That document doesn’t exist.' });
      }

      await audit(req, { action: 'document.download', clientId, entity: 'document', entityId: doc.id });

      const safeName = doc.filename.replace(/[\r\n"\\]/g, '_');
      return reply
        .header('Content-Disposition', `attachment; filename="${safeName}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Length', String(doc.sizeBytes))
        .type(doc.mime || 'application/octet-stream')
        .send(openStored(doc.storedName));
    },
  );

  /** Soft delete. Clients may only delete their own uploads; staff any. */
  app.post<{ Params: { id: string } }>(
    '/documents/:id/delete',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clientId = resolveClientId(req);
      if (!clientId) return reply.redirect('/admin', 303);
      const user = req.authContext!.user;

      const doc = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, req.params.id),
          eq(documents.clientId, clientId),
          isNull(documents.deletedAt),
        ),
      });
      if (!doc) {
        return reply.code(404).viewPage('error.eta', { title: 'Not found', message: 'That document doesn’t exist.' });
      }
      if (user.role === 'client' && doc.uploadedBy !== user.id) {
        return reply.code(403).viewPage('error.eta', {
          title: 'Not allowed',
          message: 'You can only delete files you uploaded.',
        });
      }

      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, doc.id));
      await audit(req, {
        action: 'document.delete',
        clientId,
        entity: 'document',
        entityId: doc.id,
        meta: { filename: doc.filename },
      });

      const dest = isStaff(req) ? `/documents?client=${clientId}` : '/documents';
      return reply.flash('ok', `Deleted ${doc.filename}.`).redirect(dest, 303);
    },
  );
}
