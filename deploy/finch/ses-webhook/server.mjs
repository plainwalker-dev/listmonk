import http from 'node:http';
import { pathToFileURL } from 'node:url';

// listmonk v6.2 verifies SNS signatures but does not restrict their TopicArn.
// This gateway limits signed notifications to Finch's topic. The original body
// is forwarded unchanged so listmonk still performs cryptographic verification.
export function createGateway({ topicArn, upstream = 'http://app:9000/webhooks/service/ses', fetchImpl = fetch }) {
  if (!/^arn:aws:sns:us-east-2:668857951317:[A-Za-z0-9_-]+$/.test(topicArn ?? '')) throw new Error('Set the approved Finch SNS topic ARN.');
  const certificate = /^https:\/\/sns\.us-east-2\.amazonaws\.com\/SimpleNotificationService-[a-zA-Z0-9]+\.pem$/;
  return http.createServer(async (req, res) => {
    const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(text); };
    if (req.method === 'GET' && req.url === '/health') return reply(200, 'ok');
    if (req.method !== 'POST' || req.url !== '/webhooks/service/ses') return reply(404, 'not found');
    let raw, notificationType;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) return reply(413, 'payload too large');
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks);
      const message = JSON.parse(raw.toString('utf8'));
      notificationType = message.Type;
      if (message.TopicArn !== topicArn || message.SignatureVersion !== '1' || !certificate.test(message.SigningCertURL ?? '')) return reply(403, 'untrusted notification');
      if (message.Type === 'SubscriptionConfirmation') {
        const url = new URL(message.SubscribeURL);
        if (url.origin !== 'https://sns.us-east-2.amazonaws.com' || url.username || url.password ||
            url.searchParams.get('Action') !== 'ConfirmSubscription' || url.searchParams.get('TopicArn') !== topicArn) return reply(403, 'untrusted confirmation');
      } else if (message.Type === 'Notification') {
        const event = JSON.parse(message.Message);
        if (!['Bounce', 'Complaint'].includes(event.notificationType ?? event.eventType)) return reply(400, 'unsupported event');
      } else return reply(400, 'unsupported notification');
    } catch { return reply(400, 'invalid notification'); }
    try {
      const response = await fetchImpl(upstream, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Amz-Sns-Message-Type': notificationType,
      },
        body: raw, redirect: 'error', signal: AbortSignal.timeout(15000) });
      // Do not expose upstream response bodies, recipient addresses or tokens.
      reply(response.status, response.ok ? 'accepted' : 'notification rejected');
    } catch { reply(502, 'notification processor unavailable'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway({ topicArn: process.env.SES_SNS_TOPIC_ARN });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.listen(3200, '0.0.0.0');
}
