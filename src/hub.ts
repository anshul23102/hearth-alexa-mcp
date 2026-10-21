/** Routes "something changed for this household" to that household's open MCP sessions. */
export interface Pushable { pushAlerts(): Promise<void> | void }

export class Hub {
  private sessions = new Map<string, Set<Pushable>>();
  add(household: string, s: Pushable): () => void {
    const set = this.sessions.get(household) ?? new Set();
    set.add(s); this.sessions.set(household, set);
    return () => { set.delete(s); if (set.size === 0) this.sessions.delete(household); };
  }
  /** Returns how many open sessions were told. */
  async notify(household: string): Promise<number> {
    let n = 0;
    for (const s of this.sessions.get(household) ?? []) { try { await s.pushAlerts(); n++; } catch { /* a closed session must not block the rest */ } }
    return n;
  }
  get size() { let n = 0; for (const s of this.sessions.values()) n += s.size; return n; }
}
