const sample = {
  action: 'create', title: 'Rift Review', start: '2026-10-05T14:00:00-04:00',
  end: '2026-10-05T14:30:00-04:00', timeZone: 'America/New_York',
  location: null, description: null, recurrence: null, attendees: [], ambiguities: []
};
const fakeModel = async () => JSON.stringify(sample);
class FakeCalendar {
  constructor() { this.calls = []; this.error = null; this.delayMs = 0; this.identity = 'fake:primary'; }
  async destination() { return this.identity; }
  async create(action, id) {
    this.calls.push({ action: structuredClone(action), id });
    if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (this.error) throw this.error;
    return { id: id.replaceAll('-', '') };
  }
}
module.exports = { sample, fakeModel, FakeCalendar };
