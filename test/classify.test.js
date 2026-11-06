import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply } from '../src/index.js';

// Real replies seen from real servers, and what they mean for the mailbox.
const cases = [
  [250, '2.1.5', 'OK', 'accepted'],
  [251, null, 'User not local; will forward', 'accepted'],
  [252, '2.1.5', 'Cannot VRFY user, but will accept message', 'unverifiable'],
  // Gmail
  [550, '5.1.1', "The email account that you tried to reach does not exist. Please try double-checking the recipient's email address", 'rejected'],
  [550, '5.7.1', 'Our system has detected an unusual rate of unsolicited mail originating from your IP address', 'blocked'],
  [452, '4.2.2', 'The email account that you tried to reach is over quota', 'full'],
  // Microsoft 365 directory-based edge blocking
  [550, '5.4.1', 'Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors [AS(201806281)]', 'rejected'],
  [550, '5.7.606', 'Access denied, banned sending IP [203.0.113.7]', 'blocked'],
  // Yahoo / AOL
  [554, null, "delivery error: dd This user doesn't have a yahoo.com account (someone@yahoo.com) [0]", 'rejected'],
  [554, '5.7.9', 'Message not accepted for policy reasons', 'blocked'],
  [421, '4.7.0', '[TSS04] Messages from 203.0.113.7 temporarily deferred due to unexpected volume', 'temporary'],
  // Postfix and friends
  [550, '5.1.1', '<x@example.com>: Recipient address rejected: User unknown in virtual mailbox table', 'rejected'],
  [450, '4.2.0', '<x@example.com>: Recipient address rejected: Greylisted, see http://postgrey.schweikert.ch/', 'temporary'],
  [554, '5.7.1', '<x@example.com>: Relay access denied', 'blocked'],
  [554, '5.7.1', 'Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org', 'blocked'],
  [450, '4.7.1', 'Client host rejected: cannot find your hostname', 'temporary'],
  [550, null, 'Client host rejected: cannot find your reverse hostname', 'blocked'],
  [550, '5.1.0', 'Sender address rejected: Domain not found', 'blocked'],
  [553, '5.1.8', "Domain of sender address doesn't exist", 'blocked'],
  [552, '5.2.2', 'Mailbox full', 'full'],
  [550, null, 'Mailbox quota exceeded', 'full'],
  [550, '5.2.1', 'The email account that you tried to reach is disabled', 'rejected'],
  [550, null, 'No such user here', 'rejected'],
  [550, null, 'Requested action not taken: mailbox unavailable', 'rejected'],
  [550, null, '', 'rejected'],
  [553, null, 'Requested action not taken: mailbox name not allowed', 'rejected'],
  [554, null, 'Transaction failed', 'blocked'],
  [550, null, 'Message rejected due to local policy', 'blocked'],
  [500, '5.5.1', 'Unrecognized command', 'error'],
  [503, '5.5.1', 'Bad sequence of commands', 'error'],
  [421, null, 'Service not available, closing transmission channel', 'temporary'],
  [451, '4.3.0', 'Temporary lookup failure', 'temporary'],
  [999, null, 'nonsense', 'error'],
];

for (const [code, enhanced, message, expected] of cases) {
  test(`${code} ${enhanced ?? ''} ${message.slice(0, 50)} -> ${expected}`, () => {
    assert.equal(classifyReply({ code, enhanced, message }), expected);
  });
}
