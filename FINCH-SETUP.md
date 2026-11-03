# Finch newsletter deployment

Live application: https://newsletter.finchnow.com
Fork: https://github.com/plainwalker-dev/listmonk
Draft PR: https://github.com/plainwalker-dev/listmonk/pull/1
Integration branch: feature/chatgpt-mcp, based on upstream listmonk v6.2.0.

## Current state

The application, PostgreSQL, HTTPS, private backups and a restored migration are
running. The supplied export contains 515 contacts; the user subsequently
identified the archives as mock data. Do not treat these records as a production
mailing audience or evidence for an SES production-access application.
No email has been sent. SES production access and live delivery
checks remain outstanding. Sending through MCP is disabled both in its
configuration and by the listmonk API role.

## Hosting and recovery

- Google Cloud project: finch-newsletter, number 547088214499.
- VM: finch-newsletter, zone us-east1-c; e2-small, 2 GB RAM and 2 GB swap.
- Debian 13; 30 GB balanced boot disk; deletion protection and Shielded VM.
- Static public IP: 34.138.183.90. Cloudflare newsletter A record is DNS-only.
- Estimated base cost including public IPv4: about $19/month. Backups, traffic
  and SES are additional. A $25/month alert exists; it does not cap spending.
- SSH uses OS Login through IAP. TCP 22 is limited to 35.235.240.0/20.
- Caddy alone publishes TCP 80/443. Database and MCP have no public host ports.
- Source checkout: /opt/finch-newsletter; deployment: deploy/finch.
- Root-only initial administrator/database secrets: deploy/finch/.env.
  Administrator username is finch-admin. Retrieve the password privately through
  the approved Google Cloud administrator session; never paste it into chat.
  Google-based login to listmonk itself has not been configured.
- App root URL and title are set. Public signup and campaign archives are
  disabled until the sending setup and production audience are ready.

Daily logical backups run at 04:15 UTC plus up to 15 minutes jitter, through
finch-newsletter-backup.timer. Database dumps and uploads are kept in
/var/backups/finch-newsletter. A systemd drop-in invokes upload-backup.py to copy
completed pairs to private bucket finch-newsletter-backups-547088214499.
The bucket uses uniform access and enforced public-access prevention.
The attached newsletter-backup service account has only Storage Object Creator
on that bucket. It cannot read/delete previous backups and has no saved key.
The uploader uses generation-zero preconditions and verifies size and checksum.
No automatic object pruning is configured. Disk snapshots run daily with
14-day retention, keeping existing snapshots if the disk is deleted.

A post-import dump was restored into an isolated temporary database and compared
with the live table totals: 517 subscribers, 4 lists, 1 campaign, 4 templates.
The same dump was downloaded from GCS and its SHA-256 matched the restored dump:
65a65724d6521a88a5acd85994158b232c0d7e064e35a348328c85d0a6993bb5.
The temporary restore database was dropped after verification.

A fresh backup after the ChatGPT draft, Finch template and SES configuration was
also restored successfully: listmonk-20261103T070000Z.dump, SHA-256
3067141ad9af4b6d49c275481a358bf1386e9dc086eb09e6df5f3977dc35d948.
Its totals were 517 subscribers, 4 lists, 2 campaigns and 5 templates.

For rebuilds, review bootstrap.sh, populate private secrets, start Compose, and
restore a chosen database/uploads pair using an authorized recovery operator.
The backup writer identity cannot perform recovery reads. Keep secret/config
recovery separate from source control. Never run docker compose down -v on
production. One VM is the deployment's availability boundary.

## Mailchimp migration

The migration imported and checked every source identity, name, full JSON
attributes and subscription state against both exports:

- 515 distinct mock contacts migrated.
- 489 confirmed memberships in private list 3, Finch Newsletter.
- 9 unsubscribed memberships, including one spam complaint.
- 18 globally blocklisted contacts: 17 cleaned/hard-bounce records plus that
  complaint. The complaint overlaps the nine unsubscribed records.
- Private list 4, Finch Delivery Tests, is empty.
- Two bundled sample contacts and their lists/campaign remain untouched;
  the application's global count is therefore 517, not 515.

Original fields, tags, source IDs, available subscription timestamps and exported
bounce/complaint history are preserved as subscriber attributes. No blanket
overwrite or resubscribe operation was used. Root-only import receipt:
/var/lib/finch-newsletter-migration.json.

The full Mailchimp export includes four campaign HTML files, images and reports.
It is preserved privately on the operator's computer, outside Git. At the user's
request neither source ZIP was uploaded to cloud storage. Historical reports
are not native listmonk engagement history. Mailchimp billing was untouched.

Before real cutover, obtain the intended production audience, reconcile its
consent/unsubscribe/bounce state, import a final delta and move signup forms and
integrations. Do not send to this mock migration audience.

## Amazon SES

Region: us-east-2 (Ohio), matching the account's new AWS experience project.
Identity finchnow.com uses 2048-bit Easy DKIM. All three AWS-provided DNS-only
CNAMEs are published in Cloudflare and publicly resolve. Existing Google
Workspace MX/SPF/DKIM and DMARC records were preserved. AWS now reports the identity Verified and DKIM Successful.

Outstanding delivery steps:

1. Request region-specific production access with accurate
   information about the real newsletter audience and consent process.
2. Sender is newsletter@finchnow.com; Reply-To is mediasales@finchnow.com.
   The user confirmed manual imports will include only explicit opt-ins.
   Template 5, Finch Newsletter, is the default and includes the complete
   postal footer: 141 E Houston St, Floor 5, New York, NY 10002, USA.
3. The dedicated finch-newsletter-smtp IAM user has no console login and only
   the checked-in ses-sending-policy.json: SendRawEmail for the Ohio identity,
   with From restricted to newsletter@finchnow.com. STARTTLS authentication at
   email-smtp.us-east-2.amazonaws.com:587 passed. Credentials are root-only at
   /etc/finch-newsletter/ses-smtp.json and in listmonk's private settings.
   SES delivery is disabled; listmonk's required enabled SMTP block currently
   points to a closed local port, so it cannot deliver mail accidentally.
4. SNS topic finch-newsletter-feedback uses ses-feedback-policy.json, allowing
   only the verified Finch SES identity to publish. The HTTPS subscription to
   /webhooks/service/ses is confirmed, with raw delivery disabled. Original
   headers are excluded; blocklisting works by address without campaign UUID
   attribution. Caddy routes through ses-webhook, which checks TopicArn and
   confirmation URLs before listmonk performs SNS signature verification.
   Hard bounce/complaint threshold is one; soft-bounce threshold is three.
5. Authentication and rendered unsubscribe URLs passed. Live inbox and simulator
   event checks await user approval. Do not infer successful delivery from an
   SMTP login or a confirmed subscription. Never resend blindly after a timeout.

## ChatGPT connection

The user approved a private OpenAI tunnel linking the Personal Platform
organization to the Finch ChatGPT workspace. This avoids publishing the MCP
endpoint or adding an OAuth service. The tunnel uses an outbound connection and
an unprivileged container. See mcp/README.md and compose.tunnel.yml.

The dedicated finch-chatgpt API user has campaigns:get, campaigns:manage and
templates:get, plus list:get only on lists 3 and 4. Permission probes verified
contacts, settings, users and unrelated lists are denied. No campaigns:send or
subscriber permissions are granted. The server stores private environment files
in /etc/finch-newsletter, root-readable only. No secret is committed.
The runtime key has only Tunnels Read/Use and expires December 3, 2026; renew it
privately before that date to retain the connection. Do not grant model-use,
admin-key or tunnel-management permissions to the runtime key.

Private app: https://chatgpt.com/plugins/plugin_asdk_app_6ae97b10124881918945919021cc142a
It is installed for its creator in development mode and has not been published
to the Finch workspace. A live create/update/preview check passed on draft 2,
using only empty private test list 4. The bridge corrects the v6.2 single-list
API's doubled total from its subscription-status breakdown; it never reads
contacts to calculate the membership count.

Code supports a distinct sender identity and list allowlist. A proposed
temporary test sender would have campaigns:send plus list:get only on list 4,
leaving the original drafting identity unable to send. It has not been created:
the three-message inbox/simulator test and its access await explicit approval.
FINCH_ENABLE_SEND defaults to false. Stop and disable the temporary sender
after a test, and do not grant access to the mock production-named list.

Keep the ChatGPT plugin private to its creator. The stdio tunnel is a trusted
operator boundary, not per-user OAuth: its review owner is process-local. Do
not share it with other operators without adding identity-bound authorization.
The public HTTP MCP profile remains disabled; it still requires JWT OAuth if
used instead of the tunnel. Do not enable both deployment profiles together.

The workflow is brief -> draft -> preview -> send review -> explicit approval.
Sending remains disabled pending delivery and client-confirmation validation.
A ten-minute, single-use review token checks content/template/list changes;
it is not proof of human approval. The ChatGPT client must ask for approval.
Listmonk has no atomic compare-and-send API and same-count audience changes
cannot be detected reliably; avoid direct edits between review and send.

## References

- https://listmonk.app/docs/
- https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md
