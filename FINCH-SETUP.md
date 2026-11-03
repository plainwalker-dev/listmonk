# Finch newsletter setup

Prepared for newsletter.finchnow.com, Google Cloud hosting, Amazon SES delivery,
approximately 5,000 Mailchimp contacts, and newsletter creation through ChatGPT.

## Current state

- Fork: https://github.com/plainwalker-dev/listmonk
- Local integration branch: feature/chatgpt-mcp, based on stable v6.2.0,
  upstream commit ef0a75872463f10a4848af6c547d1c057405453a.
- The MCP bridge and deployment configuration are prepared. No newsletter has
  been sent and no customer contacts have been imported.
- Google Cloud project created: `finch-newsletter` (Finch Newsletter), under
  the finchnow.com organization. No VM has been provisioned yet.
- SES verification, production access, OAuth,
  migration, and live end-to-end checks remain outstanding.

## Hosting

Start with one Google Compute Engine VM (e2-small, 2 GB RAM plus 2 GB swap) in
`finch-newsletter`, running Debian, Docker Compose, listmonk, PostgreSQL,
Caddy, and the MCP bridge. Confirm the project's existing region, billing,
network and access conventions before provisioning. This initial topology has
one VM as a failure domain; choose Cloud SQL and a separate application host
if Finch requires managed database availability.

Reserve a static public IP. Keep PostgreSQL and MCP off public host ports;
only Caddy publishes ports 80 and 443. Use the organization's existing VM
administration policy, preferably OS Login through IAP rather than public SSH.
Do not create or broaden IAM grants until the exact project is known.

1. Point a new Cloudflare A record `newsletter` to the reserved IP. Start in
   DNS-only mode so Caddy can obtain its public TLS certificate. Do not change
   the root domain's existing web or mail records.
2. Copy this checkout onto the host. In `deploy/finch`, copy `.env.example`
   to `.env` and populate strong, unique secrets using the approved secret store.
   The initial admin variables prevent an unauthenticated first-user takeover.
3. Run `docker compose up -d` from `deploy/finch`. The listmonk app automatically
   installs an empty database. Set the root URL to
   `https://newsletter.finchnow.com` and media upload path to `/listmonk/uploads`.
4. Create a dedicated listmonk API user/role with campaign get/manage/send,
   template get and list get permissions only for the newsletter lists.
   Do not use a Super Admin API token for the bridge.
5. Use `backup.sh` for database dumps and uploads, ship backups to a private
   Google Cloud Storage bucket with retention, and test a restore on an isolated
   database before importing contacts. Add persistent-disk snapshot schedules
   as an additional recovery layer. These are deployment tasks, not yet configured.

`upload-backup.py` uploads a completed database/uploads pair with generation-zero
preconditions and verifies each returned checksum. It uses the VM metadata
identity, restricted to Storage Object Creator on the dedicated private backup
bucket. It cannot read or delete existing backup objects. Configure BACKUP_BUCKET
in a systemd drop-in and run the uploader as ExecStartPost of the backup service.
Never grant project-wide Storage Admin or save a service-account key on the VM.

The Compose application uses the released listmonk image because the integration
does not modify its Go code. The MCP container is built from this fork's `mcp/`.
The VM persists container volumes across reboots; deleting a VM or disk requires
separate recovery planning. Do not run `docker compose down -v` on production.

## Amazon SES and Cloudflare

Selected region: `us-east-2` (Ohio), matching the region assigned to the signed-in
AWS project in the new AWS experience. Use that region for the SES identity,
SMTP credentials and SNS topic. The domain identity has been created with
2048-bit Easy DKIM. All three DNS-only CNAMEs are published in Cloudflare;
AWS verification is pending.

1. Create an SES domain identity for `finchnow.com`, with Easy DKIM. Copy the
   exact verification/DKIM records returned by AWS to Cloudflare. DKIM CNAMEs
   must remain DNS-only. DNS tokens cannot be invented ahead of identity creation.
2. Proposed sender: `Finch <newsletter@finchnow.com>`; confirm this address and
   choose an existing monitored Reply-To mailbox. Verifying a domain does not
   create a receiving mailbox. Preserve existing root MX and SPF records.
3. Optionally configure custom MAIL FROM `bounce.newsletter.finchnow.com`. Add
   the AWS-provided MX and SPF TXT record there, without replacing the root
   domain's existing SPF. Review existing DMARC alignment and policy.
4. Request SES production access for consent-based newsletters and sufficient
   daily/rate quotas for at least 5,000 recipients plus tests. Sandbox status is
   region-specific and is insufficient for this audience.
5. Create a dedicated least-privilege SES SMTP credential and configure
   listmonk SMTP with `email-smtp.us-east-2.amazonaws.com`, port 587, STARTTLS,
   and the generated SMTP username/password. Start with rate limits below the
   actual approved account limits. Do not use an AWS console password or an AWS
   secret access key as the SMTP password.
6. Create a standard SNS topic for bounces and complaints. Configure listmonk's
   SES bounce webhook at
   `https://newsletter.finchnow.com/webhooks/service/ses`, then subscribe it
   with raw message delivery disabled. Configure an SNS topic allowlist if
   available in the selected listmonk version. Set one hard bounce or complaint
   to blocklist, and verify behavior with the SES mailbox simulator. Include
   original headers so campaign/subscriber attribution works.

## Mailchimp migration

A supplied Mailchimp audience export contains 515 unique addresses: 489 subscribed,
9 unsubscribed, and 17 cleaned. Private CSVs have been prepared and validated,
preserving names, original fields and VENUES tags. They have not been imported.
A full account export has been requested; retrieve the existing completed
download rather than requesting another export within Mailchimp's 24-hour limit.
Keep exports private and outside Git.

1. Inventory all audiences, fields, groups, tags, subscribed contacts,
   unsubscribed contacts, non-subscribed contacts, cleaned contacts, and archived
   records where available. Record counts and normalized email duplicates per
   audience. Freeze sends and capture a final delta immediately before cutover.
2. Map each Mailchimp audience to a listmonk list, preserving list-level
   subscription state. Store merge fields, tags, source audience IDs, and
   available opt-in timestamps as JSON attributes with stable keys. Mailchimp
   tags are contact attributes; listmonk list tags and campaign tags are not
   equivalent subscriber tags. Recreate useful segments using those attributes.
3. Import only contacts with subscribed status into the corresponding
   confirmed memberships. Preserve unsubscribes per audience; never infer
   consent from the mere presence of an email address. A person can be
   unsubscribed in one audience and subscribed in another.
4. Keep cleaned addresses and complaints suppressed; do not subscribe
   non-subscribed or archived contacts. Global blocklisting is stronger than
   per-list unsubscription, so explicitly reconcile cross-audience conflicts
   before import. Do not use a blanket overwrite that revives suppressed users.
5. Convert active templates: Mailchimp merge tags, unsubscribe links, browser
   links and image hosting need listmonk equivalents. Ensure listmonk unsubscribe
   URLs and the correct Finch sender/address footer are present in rendered mail.
6. Preserve historic newsletters/reports as a private archive. They cannot be
   assumed to become native listmonk engagement history. Importing old content
   must not create a campaign that can be accidentally sent.
7. Reconcile row totals, unique addresses, membership totals and suppression
   totals; spot-check names, tags, personalization, unsubscribe behavior and
   image links. Test delivery on Finch-owned inboxes. Keep Mailchimp available
   until final unsubscribe/bounce deltas and signup forms/integrations are moved.

## ChatGPT integration

See [mcp/README.md](mcp/README.md) for installation and the tool contract.
The proposed remote endpoint is `https://newsletter.finchnow.com/mcp`.
Configure a standards-compliant OAuth provider before making that endpoint live.
The bridge validates JWT access-token signature, issuer, audience, expiry and
scopes. Credentials for listmonk and SES remain on the server.

The workflow is: brief -> create draft -> preview -> prepare send -> user
confirmation -> send. Send reviews expire in 10 minutes, belong to one OAuth
user and campaign, and are consumed once. Content, template or list metadata
changes invalidate them. Human confirmation is enforced by the MCP client,
not proven by a review token; keep explicit confirmation enabled for
`send_newsletter` and verify the actual ChatGPT prompt before enabling sends.

## Acceptance before switching over

- Project, billing and deployment owner selected; HTTPS and backup restore work.
- SES domain verified, production access granted, rate limits set, bounce and
  complaint processing tested, and DNS authentication checked.
- All migration totals reconciled, suppression states checked, signup forms
  switched and final Mailchimp deltas imported.
- OAuth login restricts access to Finch's approved operators; drafts and
  previews work from ChatGPT; confirmation, expiration, replay and changed-draft
  behavior are verified against a private test list.
- Enable live sends only after the above checks and a Finch-owned inbox test.

## Primary references

- https://listmonk.app/docs/installation/
- https://listmonk.app/docs/apis/campaigns/
- https://listmonk.app/docs/bounces/
- https://mailchimp.com/help/export-back-up-data/
- https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html
- https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
- https://docs.cloud.google.com/compute/docs/containers
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://developers.openai.com/plugins/build/auth
