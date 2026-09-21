import { describe, it, expect } from 'vitest';
import {
  MEETING_TITLE_MAX_LENGTH,
  checkMeetingTitle,
  jobDisplayName,
  jobDownloadBaseName,
} from './meetingTitle';

describe('checkMeetingTitle', () => {
  it('合法的標題 trim 後回傳', () => {
    expect(checkMeetingTitle('  Q3 預算覆盤  ')).toEqual({ ok: true, title: 'Q3 預算覆盤' });
  });

  it('不是字串時擋下來', () => {
    expect(checkMeetingTitle(42)).toEqual({ ok: false, reason: '標題必須是字串' });
    expect(checkMeetingTitle(undefined).ok).toBe(false);
    expect(checkMeetingTitle(null).ok).toBe(false);
  });

  it('只有空白算空的', () => {
    expect(checkMeetingTitle('   ')).toEqual({ ok: false, reason: '標題不能是空的' });
  });

  it('換行與其他控制字元擋下來：一個標題裡的換行會讓檔名與清單都壞掉', () => {
    expect(checkMeetingTitle('週會\n第二週').ok).toBe(false);
    expect(checkMeetingTitle('週會').ok).toBe(false);
  });

  it('長度上限用 code point 算：100 個 emoji 過、101 個字擋，訊息帶實際字數', () => {
    expect(checkMeetingTitle('😀'.repeat(MEETING_TITLE_MAX_LENGTH)).ok).toBe(true);
    const result = checkMeetingTitle('字'.repeat(MEETING_TITLE_MAX_LENGTH + 1));
    expect(result).toEqual({ ok: false, reason: `標題最多 ${MEETING_TITLE_MAX_LENGTH} 字（收到 ${MEETING_TITLE_MAX_LENGTH + 1} 字）` });
  });
});

describe('jobDisplayName', () => {
  it('有標題用標題，沒有退回原始檔名', () => {
    expect(jobDisplayName({ title: '週會', fileName: '新錄音 12.m4a' })).toBe('週會');
    expect(jobDisplayName({ fileName: '新錄音 12.m4a' })).toBe('新錄音 12.m4a');
  });
});

describe('jobDownloadBaseName', () => {
  it('沒有標題時原始檔名原樣回傳，不清理', () => {
    expect(jobDownloadBaseName({ fileName: 'a/b:c?.m4a' })).toBe('a/b:c?.m4a');
  });

  it('有標題時去掉檔案系統不收的字元與控制字元，連續空白收成一個', () => {
    expect(jobDownloadBaseName({ title: 'Q3/預算: 覆盤?  第二輪', fileName: 'x.m4a' })).toBe('Q3預算 覆盤 第二輪');
    expect(jobDownloadBaseName({ title: '<週會>|"備忘"', fileName: 'x.m4a' })).toBe('週會備忘');
  });

  it('標題清完是空的才退回原始檔名', () => {
    expect(jobDownloadBaseName({ title: '???', fileName: 'x.m4a' })).toBe('x.m4a');
  });

  it('中括號也去掉，跟 vaultProjector.ts 的 sanitizeTitle 同一組字元', () => {
    expect(jobDownloadBaseName({ title: 'Q1 Review [DRAFT]', fileName: 'x.m4a' })).toBe('Q1 Review DRAFT');
  });
});
