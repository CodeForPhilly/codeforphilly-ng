# Inbound webhooks

Endpoints other systems call. None of them is reachable through the SPA; all
are secret-guarded and answer in the standard envelope.

| Method | Path | Caller | Purpose |
| ------ | ---- | ------ | ------- |
| `POST` | `/api/_webhooks/postmark/bounce` | Postmark | Record hard bounces and spam complaints on the member's private profile. |

## POST /api/_webhooks/postmark/bounce

Postmark's [Bounce webhook](https://postmarkapp.com/developer/webhooks/bounce-webhook).
Configured on the Postmark server that sends our notifications, with either
HTTP basic auth (any username, password = the secret) or an `Authorization:
Bearer <secret>` header. The secret is `POSTMARK_WEBHOOK_SECRET`.

### Behavior

1. If `POSTMARK_WEBHOOK_SECRET` is unset → `503 not_configured` (mirrors the
   reload webhook: the route exists, the feature is off).
2. Authenticate: bearer token or basic-auth password must equal the secret
   (constant-time compare). Otherwise `401 unauthenticated`.
3. Accept only `RecordType = "Bounce"` (and Postmark's `SpamComplaint` variant,
   which arrives on the same webhook with `Type = "SpamComplaint"`). Anything
   else → `200` with `{ "ignored": true }`, so Postmark does not retry.
4. Resolve `Email` (case-insensitive) to a person through the private store's
   email index. Unknown address → `200 { "matched": false }`.
5. Store on the private profile:

   ```json
   "emailBounce": { "type": "HardBounce", "bouncedAt": "…", "description": "…", "inactive": true }
   ```

   Only bounce types that mean "this mailbox is not going to work" are kept:
   `HardBounce`, `SpamComplaint`, `SpamNotification`, `Blocked`, `DnsError`,
   `BadEmailAddress`, `ManuallyDeactivated`, `Unsubscribe`. Transient types
   (`Transient`, `SoftBounce`, `DMARCPolicy`, …) are acknowledged and dropped.
   A later successful delivery does not clear the record; staff can see the
   date and judge.
6. Respond `200 { "matched": true, "recorded": <bool> }`. Never 4xx/5xx on a
   well-formed, authenticated payload — Postmark retries on failure and the
   data is advisory.

### Why

A hard bounce is the one reliable "this mailbox is disabled" signal we get,
and we get it for free from mail we already send. It replaces any temptation
to probe mailboxes over SMTP, which is unreliable and gets the sending IP
listed.

### Relationship to other specs

- [behaviors/private-storage.md](../behaviors/private-storage.md) — the
  `emailBounce` field.
- [api/moderation.md](moderation.md) — surfaced on the roster as a signal.
