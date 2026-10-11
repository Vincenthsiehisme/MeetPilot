import { describe, expect, it } from 'vitest';
import {
  HIDDEN_LAUNCH_ARG, notificationFor, parseActivityMessage, quitPrompt, shouldBlockSleep, shouldOpenAtLogin, startedHidden, resolveQuitResponse, updateInstallNote,
} from './desktopActivity';

const valid = {
  type: 'meetpilot-activity',
  schema: 1,
  active: 2,
  events: [
    { meetingId: 'm1', title: '週會', kind: 'done', reason: null },
    { meetingId: 'm2', title: null, kind: 'failed', reason: 'fetch failed' },
  ],
};

describe('parseActivityMessage', () => {
  it('合法訊息原樣收下，多出來的欄位放行', () => {
    expect(parseActivityMessage(valid)).toEqual({
      kind: 'ok',
      message: { active: 2, events: [valid.events[0], valid.events[1]] },
    });
    expect(parseActivityMessage({ ...valid, extra: 1, events: [] })).toEqual({ kind: 'ok', message: { active: 2, events: [] } });
    expect(parseActivityMessage({ ...valid, active: 0, events: [] })).toEqual({ kind: 'ok', message: { active: 0, events: [] } });
  });

  it.each([
    ['null', null],
    ['字串', 'meetpilot-activity'],
    ['陣列', []],
    ['type 不對', { ...valid, type: 'other' }],
    ['沒有 type', { schema: 1, active: 0, events: [] }],
    ['schema 不是 1', { ...valid, schema: 2 }],
    ['schema 是字串', { ...valid, schema: '1' }],
    ['active 是負數', { ...valid, active: -1 }],
    ['active 是小數', { ...valid, active: 1.5 }],
    ['active 是字串', { ...valid, active: '2' }],
    ['active 是 NaN', { ...valid, active: Number.NaN }],
    ['沒有 active', { type: 'meetpilot-activity', schema: 1, events: [] }],
    ['events 不是陣列', { ...valid, events: {} }],
    ['沒有 events', { type: 'meetpilot-activity', schema: 1, active: 1 }],
    ['event 不是物件', { ...valid, events: ['x'] }],
    ['meetingId 空字串', { ...valid, events: [{ meetingId: '', title: null, kind: 'done', reason: null }] }],
    ['meetingId 不是字串', { ...valid, events: [{ meetingId: 7, title: null, kind: 'done', reason: null }] }],
    ['title 是數字', { ...valid, events: [{ meetingId: 'm', title: 1, kind: 'done', reason: null }] }],
    ['沒有 title', { ...valid, events: [{ meetingId: 'm', kind: 'done', reason: null }] }],
    ['kind 不認得', { ...valid, events: [{ meetingId: 'm', title: null, kind: 'queued', reason: null }] }],
    ['reason 是物件', { ...valid, events: [{ meetingId: 'm', title: null, kind: 'failed', reason: {} }] }],
    ['沒有 reason', { ...valid, events: [{ meetingId: 'm', title: null, kind: 'failed' }] }],
  ])('形狀不對整則不收並回原因：%s', (_name, raw) => {
    const result = parseActivityMessage(raw);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).not.toBe('');
  });

  it('一個 event 壞了整則不收，不留下前面好的那幾個', () => {
    const result = parseActivityMessage({ ...valid, events: [valid.events[0], { meetingId: 'm', title: null, kind: 'x', reason: null }] });
    expect(result).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('events[1].kind') });
  });
});

describe('shouldBlockSleep', () => {
  it.each([
    [false, 0, false],
    [true, 0, true],
    [false, 1, true],
    [true, 3, true],
  ])('錄音 %s、處理中 %i 場 → 擋 %s', (recording, active, expected) => {
    expect(shouldBlockSleep({ recording, active })).toBe(expected);
  });
});

describe('quitPrompt', () => {
  it('都沒有就不問', () => {
    expect(quitPrompt({ recording: false, active: 0 })).toBeNull();
  });

  it('只有錄音：文案維持原本的', () => {
    const prompt = quitPrompt({ recording: true, active: 0 });
    expect(prompt).toMatchObject({ message: '正在錄音，要結束 MeetPilot 嗎？', buttons: ['繼續錄音', '結束 MeetPilot'], logNote: '錄音中' });
    expect(prompt?.detail).toContain('下次打開 MeetPilot 可以把它送去轉錄');
  });

  it('只有處理中：講還有幾場在處理，結束後下次打開會接著跑', () => {
    const prompt = quitPrompt({ recording: false, active: 3 });
    expect(prompt?.message).toContain('3 場會議在處理');
    expect(prompt?.detail).toContain('下次打開 MeetPilot 會接著跑');
    expect(prompt?.buttons).toEqual(['繼續處理', '結束 MeetPilot']);
  });

  it('錄音與處理同時成立只出一份，兩件事都講', () => {
    const prompt = quitPrompt({ recording: true, active: 2 });
    expect(prompt?.message).toContain('正在錄音');
    expect(prompt?.message).toContain('2 場會議在處理');
    expect(prompt?.detail).toContain('中斷錄音');
    expect(prompt?.detail).toContain('接著跑');
    expect(prompt?.buttons).toHaveLength(2);
  });
});

describe('裝更新時的結束', () => {
  it('更新是使用者已經確認要結束的動作：處理中那項不再問', () => {
    expect(quitPrompt({ recording: false, active: 3, ignoreProcessing: true })).toBeNull();
  });

  it('錄音中照舊問，而且只講錄音，不提處理中', () => {
    const prompt = quitPrompt({ recording: true, active: 3, ignoreProcessing: true });
    expect(prompt).toMatchObject({ message: '正在錄音，要結束 MeetPilot 嗎？', logNote: '錄音中' });
  });

  it('沒給 ignoreProcessing 時行為不變', () => {
    expect(quitPrompt({ recording: false, active: 3 })?.message).toContain('3 場會議在處理');
  });

  it('確認對話框補一句：有處理中的會議才說，下次打開會接著跑', () => {
    expect(updateInstallNote(0)).toBe('');
    expect(updateInstallNote(2)).toContain('2 場會議還在處理');
    expect(updateInstallNote(2)).toContain('下次打開');
  });
});

describe('resolveQuitResponse', () => {
  it('按「結束」：確認結束，裝更新的旗標維持（接著的 app.quit() 不再問處理中）', () => {
    expect(resolveQuitResponse(1, true)).toEqual({ confirmed: true, updateQuitting: true });
    expect(resolveQuitResponse(1, false)).toEqual({ confirmed: true, updateQuitting: false });
  });

  it('按「不結束」：app 沒結束，裝更新的旗標歸零，之後正常結束照問處理中', () => {
    expect(resolveQuitResponse(0, true)).toEqual({ confirmed: false, updateQuitting: false });
    expect(resolveQuitResponse(0, false)).toEqual({ confirmed: false, updateQuitting: false });
  });
});

describe('notificationFor', () => {
  it('完成：標題講完成，內文是會議標題', () => {
    expect(notificationFor({ meetingId: 'm1', title: '週會', kind: 'done', reason: null }))
      .toEqual({ title: '會議記錄完成', body: '週會' });
  });

  it('完成但帶原因（關聯失敗）：原因一併講', () => {
    expect(notificationFor({ meetingId: 'm1', title: '週會', kind: 'done', reason: '關聯失敗：quota' }).body)
      .toBe('週會\n關聯失敗：quota');
  });

  it('失敗：帶原因', () => {
    expect(notificationFor({ meetingId: 'm2', title: '客訴檢討', kind: 'failed', reason: 'fetch failed' }))
      .toEqual({ title: '會議處理失敗', body: '客訴檢討\nfetch failed' });
  });

  it('失敗沒有原因：明說沒有記錄，不留空', () => {
    expect(notificationFor({ meetingId: 'm2', title: '客訴檢討', kind: 'failed', reason: null }).body).toBe('客訴檢討\n沒有記錄失敗原因');
    expect(notificationFor({ meetingId: 'm2', title: '客訴檢討', kind: 'failed', reason: '  ' }).body).toBe('客訴檢討\n沒有記錄失敗原因');
  });

  it('沒有標題寫未命名會議', () => {
    expect(notificationFor({ meetingId: 'm3', title: null, kind: 'done', reason: null }).body).toBe('未命名會議');
    expect(notificationFor({ meetingId: 'm3', title: ' ', kind: 'failed', reason: 'x' }).body).toBe('未命名會議\nx');
  });

  it('超長原因壓成一行並截斷', () => {
    const body = notificationFor({ meetingId: 'm', title: 't', kind: 'failed', reason: `a\n\n${'b'.repeat(500)}` }).body;
    const reason = body.split('\n')[1];
    expect(reason.startsWith('a b')).toBe(true);
    expect(reason.length).toBe(201);
    expect(reason.endsWith('…')).toBe(true);
  });
});

describe('開機自動啟動', () => {
  it('打包版、選過資料夾、不是冒煙測試才登記', () => {
    expect(shouldOpenAtLogin({ vaultDir: '/v', isPackaged: true, smoke: false })).toBe(true);
    expect(shouldOpenAtLogin({ vaultDir: null, isPackaged: true, smoke: false })).toBe(false);
    expect(shouldOpenAtLogin({ vaultDir: '', isPackaged: true, smoke: false })).toBe(false);
    expect(shouldOpenAtLogin({ vaultDir: '/v', isPackaged: false, smoke: false })).toBe(false);
    expect(shouldOpenAtLogin({ vaultDir: '/v', isPackaged: true, smoke: true })).toBe(false);
  });

  it('開機啟動不跳視窗：Windows 看參數，macOS 看系統說的', () => {
    expect(startedHidden({ argv: ['MeetPilot.exe', HIDDEN_LAUNCH_ARG], wasOpenedAtLogin: false })).toBe(true);
    expect(startedHidden({ argv: ['MeetPilot'], wasOpenedAtLogin: true })).toBe(true);
    expect(startedHidden({ argv: ['MeetPilot'], wasOpenedAtLogin: false })).toBe(false);
  });
});
