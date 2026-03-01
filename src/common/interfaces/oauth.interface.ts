// Typed shape of the OAuth provider profile object.
// This replaces `profile?: any` — gives autocomplete and prevents typos.
export interface OAuthProfile {
  id: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  picture?: string;
  locale?: string;
  [key: string]: unknown; // allow provider-specific extra fields
}