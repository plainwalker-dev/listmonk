import { createHash, randomUUID } from 'node:crypto';

export class ListmonkClient {
  constructor({ url, user, token, allowedListIds, fetchImpl = fetch }) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) {
      throw new Error('LISTMONK_URL must be an HTTP(S) URL without credentials.');
    }
    if (!user || !token || !allowedListIds?.length || allowedListIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
      throw new Error('Set API credentials and a nonempty LISTMONK_ALLOWED_LIST_IDS allowlist.');
    }
    this.allowed = new Set(allowedListIds);
    this.authorization = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
    this.fetchImpl = fetchImpl;
  }
  async request(path, { method = 'GET', body, text = false } = {}) {
    // All callers use fixed API paths; never accept a destination from chat.
    const response = await this.fetchImpl(new URL(path, this.url), {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: this.authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Listmonk returned HTTP ${response.status}; inspect listmonk's logs.`);
    return text ? response.text() : (await response.json()).data;
  }
  checkLists(ids) {
    if (!ids.length || ids.some(id => !this.allowed.has(id))) throw new Error('Campaign contains a list outside the configured allowlist.');
  }
  async getCampaign(id) {
    const campaign = await this.request(`/api/campaigns/${id}`);
    this.checkLists((campaign.lists ?? []).map(list => list.id));
    return campaign;
  }
  async listLists() {
    // Fetch individually so the bridge never returns unrelated list metadata.
    return Promise.all([...this.allowed].map(id => this.request(`/api/lists/${id}`)));
  }
  async createDraft(input) {
    this.checkLists(input.lists);
    const draft = await this.request('/api/campaigns', {
      method: 'POST', body: { ...input, type: 'regular', messenger: 'email' },
    });
    if (draft.status !== 'draft') throw new Error('Unexpected campaign status; inspect listmonk before proceeding.');
    return draft;
  }
  async updateDraft(id, input) {
    const existing = await this.getCampaign(id);
    if (existing.status !== 'draft') throw new Error('Only drafts can be edited through MCP.');
    if (existing.type !== 'regular' || existing.messenger !== 'email' || existing.send_at ||
        existing.media?.length || existing.headers?.length || Object.keys(existing.attribs ?? {}).length || existing.archive) {
      throw new Error('This draft has settings not supported by MCP editing. Edit it in listmonk.');
    }
    this.checkLists(input.lists);
    return this.request(`/api/campaigns/${id}`, {
      method: 'PUT', body: { ...input, type: 'regular', messenger: 'email' },
    });
  }
  async snapshot(id) {
    const campaign = await this.getCampaign(id);
    if (campaign.status !== 'draft' || campaign.type !== 'regular' || campaign.messenger !== 'email') {
      throw new Error('Only a regular draft email campaign can be sent.');
    }
    // A changed template or audience count invalidates the pending approval too.
    const templates = await this.request('/api/templates');
    const template = campaign.template_id
      ? templates.find(t => t.id === campaign.template_id)
      : templates.find(t => t.is_default && t.type === 'campaign');
    if (!template) throw new Error('The campaign template could not be resolved.');
    const lists = await Promise.all(campaign.lists.map(l => this.request(`/api/lists/${l.id}`)));
    if (lists.some(l => l.status === 'archived')) throw new Error('An audience list is archived.');
    const html = await this.request(`/api/campaigns/${id}/preview`, { text: true });
    const fingerprint = createHash('sha256').update(JSON.stringify({ campaign, template, lists, html })).digest('hex');
    return { campaign, template, lists, html, fingerprint };
  }
}

// One process owns all pending reviews, across stateless HTTP requests.
// Restarting drops reviews. Tokens are single-use and scoped to the OAuth subject.
export class SendReviews {
  constructor({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }
  prepare(owner, id, fingerprint) {
    for (const [key, review] of this.pending) if (review.expires <= this.now()) this.pending.delete(key);
    if (this.pending.size >= 1000) throw new Error('Too many pending reviews; wait for existing reviews to expire.');
    const token = randomUUID();
    const expires = this.now() + this.ttlMs;
    this.pending.set(token, { owner, id, fingerprint, expires });
    return { review_token: token, expires_at: new Date(expires).toISOString() };
  }
  consume(token, owner, id, fingerprint) {
    const review = this.pending.get(token);
    if (!review || review.owner !== owner || review.id !== id) throw new Error('Invalid review token for this user and campaign.');
    this.pending.delete(token);
    if (review.expires <= this.now()) throw new Error('Review expired. Prepare and approve the newsletter again.');
    if (review.fingerprint !== fingerprint) throw new Error('The newsletter or audience changed. Prepare and approve it again.');
  }
}
