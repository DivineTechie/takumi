import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as apiModule from '../api';
import { buildCopilotTools, summariseMachines } from './copilotTools';
import { CopilotSession, COPILOT_INSTRUCTION } from './copilot';

vi.mock('../api', () => ({
  liveToken: vi.fn(),
  fetchMachines: vi.fn(),
  fetchOrders: vi.fn(),
  fetchControlSummary: vi.fn(),
  fetchWorkOrders: vi.fn(),
  runDemandAgent: vi.fn(),
}));

vi.mock('./audio', () => ({
  createAndResumeAudioContexts: () => ({ outputContext: { close: vi.fn().mockResolvedValue(undefined) }, micContext: { close: vi.fn().mockResolvedValue(undefined) } }),
  createSilencePcmBase64: () => 'AAAA',
  setupMicCapture: vi.fn().mockResolvedValue({ stop: vi.fn() }),
  OutputAudioQueue: class {
    enqueueBase64 = vi.fn();
    flush = vi.fn();
    isPlayingWithTail = () => false;
  },
}));

const NOW = Date.parse('2026-10-11T12:00:00Z');
const machine = (id: string, name: string, state: string, minsAgo: number | null, extra = {}) =>
  ({ id, name, state, source: 'VIRTUAL', last_alarm: state === 'stopped' ? 'E-221 COOLANT LOW' : null, last_count: 40,
     last_seen_at: minsAgo === null ? null : new Date(NOW - minsAgo * 60_000).toISOString(), ...extra }) as unknown as apiModule.Machine;

describe('copilot tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports stale machines as not watched, with source labels', () => {
    const out = summariseMachines([machine('a', 'Press 2', 'stopped', 1), machine('b', 'Packer 3', 'stopped', 30)], NOW);
    expect(out[0]).toMatchObject({ name: 'Press 2', state: 'stopped', alarm: 'E-221 COOLANT LOW', source: 'HOME RIG', minutes_since_last_reading: 1 });
    expect(out[1]).toMatchObject({ state: 'no camera watching', alarm: null });
  });

  it('drafts a work order only for a freshly watched stopped machine', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(apiModule.fetchMachines).mockResolvedValue([
      machine('old', 'Press 2', 'stopped', 40),
      machine('new', 'Press 2', 'stopped', 1),
      machine('run', 'CNC Mill 1', 'running', 1),
    ]);
    const draft = vi.fn().mockResolvedValue({
      machine_name: 'Press 2', status: 'draft', source: 'HOME RIG',
      draft: { title: 'Press 2: coolant low', priority: 'high', summary: 's', likely_causes: [{ cause: 'Tank low', evidence: 'e' }], steps: ['Top up'] },
    });
    const tool = buildCopilotTools(draft).find((t) => t.name === 'draft_work_order')!;
    const res = (await tool.run({ machine_name: 'press 2' })) as { drafted: { most_likely_cause: string } };
    expect(draft.mock.calls[0][0].id).toBe('new');
    expect(res.drafted.most_likely_cause).toBe('Tank low');
    expect(await tool.run({ machine_name: 'CNC Mill 1' })).toEqual({ error: 'CNC Mill 1 is running, not stopped; no work order needed.' });
    expect(await tool.run({ machine_name: 'Lathe' })).toHaveProperty('error');
    vi.restoreAllMocks();
  });

  it('keeps the model grounded and unable to approve', () => {
    expect(COPILOT_INSTRUCTION).toMatch(/must come from a tool result/);
    expect(COPILOT_INSTRUCTION).toMatch(/cannot approve/);
  });
});

class FakeWS {
  static OPEN = 1;
  static last: FakeWS | null = null;
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
}

describe('CopilotSession', () => {
  it('sets up tools, runs tool calls and returns their results', async () => {
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) } });
    vi.mocked(apiModule.liveToken).mockResolvedValue({ token: 'tok', model: 'gemini-3.8-live', max_minutes: 10 } as never);
    const onTool = vi.fn();
    const onModelText = vi.fn();
    const run = vi.fn().mockResolvedValue({ machines: [] });
    const s = new CopilotSession([{ name: 'get_machines_now', description: 'd', run }], {
      onState: vi.fn(), onUserText: vi.fn(), onModelText, onTool, onError: vi.fn(),
    });
    await s.start();
    const ws = FakeWS.last!;
    expect(ws.url).toContain('BidiGenerateContentConstrained?access_token=tok');
    ws.onopen!();
    const setup = (ws.sent[0] as { setup: { model: string; tools: { functionDeclarations: { name: string }[] }[]; inputAudioTranscription: object } }).setup;
    expect(setup.model).toBe('models/gemini-3.8-live');
    expect(setup.tools[0].functionDeclarations[0].name).toBe('get_machines_now');
    expect(setup.inputAudioTranscription).toEqual({});

    ws.onmessage!({ data: JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'get_machines_now', args: {} }] } }) });
    await vi.waitFor(() => expect(ws.sent.length).toBe(2));
    expect(ws.sent[1]).toEqual({ toolResponse: { functionResponses: [{ id: 'c1', name: 'get_machines_now', response: { result: { machines: [] } } }] } });
    expect(onTool).toHaveBeenCalledWith('get_machines_now', 'done');

    ws.onmessage!({ data: JSON.stringify({ serverContent: { outputTranscription: { text: 'All machines {pause} are running.' } } }) });
    ws.onmessage!({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    await vi.waitFor(() => expect(onModelText).toHaveBeenLastCalledWith('All machines are running.', true));
    s.stop();
    vi.unstubAllGlobals();
  });
});
