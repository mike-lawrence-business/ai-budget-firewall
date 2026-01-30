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
        // Durable Objects storage does not provide true transactions but single DO instance ensures atomicity per object
        const prevRaw = await this.state.storage.get(key);
        const prev = prevRaw ? parseFloat(prevRaw) : 0;
        const next = prev + amount;
        await this.state.storage.put(key, next.toString());
        return new Response(JSON.stringify({ date, prev, next }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
}
