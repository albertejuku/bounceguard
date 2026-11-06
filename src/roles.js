// Shared role mailboxes (info@, admin@, noreply@). They usually exist, but they are read by teams or nobody,
// complain more often and are a poor fit for marketing mail. Flagged, and only held if the policy says so.
export const ROLE_NAMES = Object.freeze([
  'abuse', 'accounts', 'accounting', 'admin', 'administrator', 'billing', 'careers', 'contact', 'customercare',
  'customerservice', 'customer-service', 'donotreply', 'do-not-reply', 'enquiries', 'enquiry', 'feedback', 'finance',
  'hello', 'help', 'helpdesk', 'hostmaster', 'hr', 'info', 'inquiries', 'inquiry', 'jobs', 'legal', 'mail',
  'mailer-daemon', 'marketing', 'media', 'news', 'newsletter', 'no-reply', 'noreply', 'no_reply', 'office', 'orders',
  'postmaster', 'press', 'privacy', 'recruitment', 'root', 'sales', 'security', 'service', 'support', 'team',
  'webmaster', 'www',
]);

const SET = new Set(ROLE_NAMES);

/** True when the local part (before any +tag) is a role name. */
export function isRoleAddress(local) {
  const name = String(local).toLowerCase().split('+')[0];
  return SET.has(name);
}
