/**
 * One file to attach to an outgoing email.
 *
 * Deliberately a narrow subset of nodemailer's own `Attachment`: `filename`
 * plus an in-memory `content` Buffer and an explicit `contentType`. Nodemailer
 * also accepts a `path` or a `stream`, and both are omitted on purpose —
 * a `path` would let a caller name any file the process can read, and a stream
 * cannot be size-checked before the send is attempted.
 */
export interface EmailAttachment {
  /** Name offered to the recipient's mail client. */
  filename: string;
  content: Buffer;
  /** e.g. `text/csv`, `application/pdf`. Omitted, clients guess from the name. */
  contentType?: string;
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Files to attach. Nodemailer supports this directly; `MailService` caps the
   * total size (`MAIL_MAX_ATTACHMENT_BYTES`) and refuses to send rather than
   * handing a 50 MB message to the SMTP relay — see `sendEmail()`.
   */
  attachments?: EmailAttachment[];
}

export interface EmailTemplateData {
  [key: string]: any;
}
