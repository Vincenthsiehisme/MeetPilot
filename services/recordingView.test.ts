import { describe, it, expect } from 'vitest';
import { MeetingView } from './meetingApi';
import { findRecordingMeeting, formatRecordingElapsed, recordingMeetingFileName } from './recordingView';

const view = (overrides: Partial<MeetingView>): MeetingView => ({
  meeting_id: 'm_1',
  title: null,
  status: 'CREATED',
  created_at: 1,
  updated_at: 1,
  source_file_name: 'a.m4a',
  source_file_size: 1,
  origin: 'native',
  error: null,
  processed_slices: null,
  total_slices: null,
  meeting_context: null,
  topic_extraction_status: null,
  topic_extraction_error: null,
  has_audio: false,
  recording_started_at: null,
  ...overrides,
});

describe('formatRecordingElapsed', () => {
  it('一小時內是 mm:ss', () => {
    expect(formatRecordingElapsed(0, 0)).toBe('00:00');
    expect(formatRecordingElapsed(0, 59_999)).toBe('00:59');
    expect(formatRecordingElapsed(0, 61_000)).toBe('01:01');
    expect(formatRecordingElapsed(0, 3_599_000)).toBe('59:59');
  });

  it('超過一小時是 h:mm:ss（實體會議常見 90 分鐘以上）', () => {
    expect(formatRecordingElapsed(0, 3_600_000)).toBe('1:00:00');
    expect(formatRecordingElapsed(0, 5_525_000)).toBe('1:32:05');
  });

  it('時鐘倒退時顯示 00:00，不顯示負數', () => {
    expect(formatRecordingElapsed(10_000, 0)).toBe('00:00');
  });
});

describe('recordingMeetingFileName', () => {
  it('寫成哪一天幾點錄的，補零', () => {
    expect(recordingMeetingFileName(new Date(2026, 8, 3, 9, 5))).toBe('語音備忘錄錄音 2026-09-03 09:05');
  });
});

describe('findRecordingMeeting', () => {
  it('找出正在錄的那一場', () => {
    const meetings = [view({ meeting_id: 'a', status: 'LINKED' }), view({ meeting_id: 'b', status: 'RECORDING', recording_started_at: 5 })];
    expect(findRecordingMeeting(meetings)?.meeting_id).toBe('b');
  });

  it('沒有在錄或清單還沒讀到都是 null', () => {
    expect(findRecordingMeeting([view({ status: 'TRANSCRIBING' })])).toBeNull();
    expect(findRecordingMeeting(null)).toBeNull();
  });

  it('同時兩場在錄直接拋錯，不挑一場去停', () => {
    const meetings = [view({ meeting_id: 'a', status: 'RECORDING' }), view({ meeting_id: 'b', status: 'RECORDING' })];
    expect(() => findRecordingMeeting(meetings)).toThrow(/同時有 2 場會在錄音/);
  });
});
