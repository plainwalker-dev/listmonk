import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateway } from './server.mjs';

const topicArn = 'arn:aws:sns:us-east-2:668857951317:finch-newsletter-feedback';
const notification = { TopicArn: topicArn, Type: 'Notification', SignatureVersion: '1', Signature: 'upstream-validates-this',
  SigningCertURL: 'https://sns.us-east-2.amazonaws.com/SimpleNotificationService-abc123.pem',
  Message: JSON.stringify({ notificationType: 'Complaint', mail: { destination: ['test@example.com'] } }) };
test('only Finch topic events reach the signature verifier and its rejection is preserved', async t => {
  const calls = [];
  const server = createGateway({ topicArn, fetchImpl: async (...args) => { calls.push(args); return new Response('', { status: 403 }); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/service/ses`;
  const send = body => fetch(url, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await send({ ...notification, TopicArn: 'arn:aws:sns:us-east-2:111111111111:other' })).status, 403);
  assert.equal((await send({ ...notification, SigningCertURL: 'https://attacker.example/cert.pem' })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await send(notification)).status, 403);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].body.toString(), JSON.stringify(notification));
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers['X-Amz-Sns-Message-Type'], 'Notification');
});
test('subscription confirmation cannot target another URL or topic', async t => {
  let forwarded = 0;
  const server = createGateway({ topicArn, fetchImpl: async (_url, options) => {
    assert.equal(options.headers['X-Amz-Sns-Message-Type'], 'SubscriptionConfirmation');
    forwarded++; return new Response('');
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/service/ses`;
  const confirmation = { ...notification, Type: 'SubscriptionConfirmation' };
  for (const SubscribeURL of ['https://attacker.example/', 'https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=other']) {
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ ...confirmation, SubscribeURL }) })).status, 403);
  }
  const SubscribeURL = 'https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=' + encodeURIComponent(topicArn) + '&Token=test';
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ ...confirmation, SubscribeURL }) })).status, 200);
  assert.equal(forwarded, 1);
});
