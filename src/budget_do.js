export class BudgetCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env; // access to bindings if needed
  }

  // Helper to build date key
  _dateKey(dateStr) {
    return `usage:${dateStr}`;
  }

  // Fetch handler: GET /get?date=YYYY-MM-DD -> {date, amount}
  // POST /add body {date, amount} -> {prev, new}
  // POST /processed body {requestId} -> {wasNew: true|false}
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/get') {
      const date = url.searchParams.get('date');
      if (!date) return new Response(JSON.stringify({ error: 'missing date' }), { status: 400 });
      const key = this._dateKey(date);
      const stored = await this.state.storage.get(key);
      const amount = stored ? parseFloat(stored) : 0;
      return new Response(JSON.stringify({ date, amount }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (req.method === 'POST' && pathname === '/add') {
      try {
        const body = await req.json();
        const date = body.date;
        const amount = parseFloat(body.amount) || 0;
        if (!date) return new Response(JSON.stringify({ error: 'missing date' }), { status: 400 });
        const key = this._dateKey(date);
        // Atomic increment via transaction-like read-modify-write
        // Durable Objects storage is single-threaded per object so this is atomic per budgetId
        const prevRaw = await this.state.storage.get(key);
        const prev = prevRaw ? parseFloat(prevRaw) : 0;
        const next = prev + amount;
        await this.state.storage.put(key, next.toString());
        return new Response(JSON.stringify({ date, prev, next }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    // Idempotency helper: mark a requestId as processed
    if (req.method === 'POST' && pathname === '/processed') {
      try {
        const body = await req.json();
        const requestId = body && body.requestId;
        if (!requestId) return new Response(JSON.stringify({ error: 'missing requestId' }), { status: 400 });
        const key = `processed:${requestId}`;
        const existing = await this.state.storage.get(key);
        if (existing) {
          return new Response(JSON.stringify({ wasNew: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // Mark as processed with a timestamp. No TTL API on DO storage; store timestamp for housekeeping.
        const ts = Date.now();
        await this.state.storage.put(key, String(ts));
        return new Response(JSON.stringify({ wasNew: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
}
