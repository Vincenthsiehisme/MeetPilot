import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_AUDIO_ACCEPT_ATTR,
  ACCEPTED_AUDIO_EXTENSIONS,
  isAcceptedAudioFile,
  pickDroppedAudioFile,
} from './droppedFiles';

const file = (name: string, type: string): File => new File(['x'], name, { type });

describe('isAcceptedAudioFile', () => {
  it('audio/* 與 video/* 的 MIME type 一律接受', () => {
    expect(isAcceptedAudioFile(file('a.mp3', 'audio/mpeg'))).toBe(true);
    expect(isAcceptedAudioFile(file('a.mov', 'video/quicktime'))).toBe(true);
  });

  it('MIME type 是空字串時退回看副檔名（.m4a 常見情況）', () => {
    expect(isAcceptedAudioFile(file('voice.m4a', ''))).toBe(true);
  });

  it('副檔名比對不分大小寫', () => {
    expect(isAcceptedAudioFile(file('VOICE.M4A', ''))).toBe(true);
  });

  it('每一種清單裡的副檔名都接受', () => {
    for (const ext of ACCEPTED_AUDIO_EXTENSIONS) {
      expect(isAcceptedAudioFile(file(`x${ext}`, ''))).toBe(true);
    }
  });

  it('不對的型別與副檔名一律拒絕', () => {
    expect(isAcceptedAudioFile(file('photo.png', 'image/png'))).toBe(false);
    expect(isAcceptedAudioFile(file('note.txt', 'text/plain'))).toBe(false);
    expect(isAcceptedAudioFile(file('noext', ''))).toBe(false);
  });
});

describe('ACCEPTED_AUDIO_ACCEPT_ATTR', () => {
  it('是 audio/*、video/* 加上副檔名清單組成的字串，跟 isAcceptedAudioFile 同一份判準', () => {
    expect(ACCEPTED_AUDIO_ACCEPT_ATTR).toContain('audio/*');
    expect(ACCEPTED_AUDIO_ACCEPT_ATTR).toContain('video/*');
    for (const ext of ACCEPTED_AUDIO_EXTENSIONS) {
      expect(ACCEPTED_AUDIO_ACCEPT_ATTR).toContain(ext);
    }
  });
});

describe('pickDroppedAudioFile', () => {
  it('剛好一個可接受的檔案時回傳它', () => {
    const f = file('meeting.m4a', '');
    const result = pickDroppedAudioFile([f]);
    expect(result).toEqual({ ok: true, file: f });
  });

  it('沒有檔案時擋下來，訊息列出 dataTransfer.types 讓使用者回報得出來源', () => {
    const result = pickDroppedAudioFile([], ['text/plain', 'text/uri-list']);
    expect(result.ok === false && result.reason).toContain('沒有偵測到檔案');
    expect(result.ok === false && result.reason).toContain('text/plain、text/uri-list');
  });

  it('沒有檔案也沒有型別時寫「無」，不留一個空的括號', () => {
    const result = pickDroppedAudioFile([]);
    expect(result.ok === false && result.reason).toContain('型別：無');
  });

  it('超過一個檔案時擋下來，不悄悄只送第一個（避免使用者以為其餘的也送出去了）', () => {
    const result = pickDroppedAudioFile([file('a.mp3', 'audio/mpeg'), file('b.mp3', 'audio/mpeg')]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('偵測到 2 個');
  });

  it('型別不對時擋下來，訊息帶檔名與支援格式', () => {
    const result = pickDroppedAudioFile([file('photo.png', 'image/png')]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('photo.png');
    expect(result.ok === false && result.reason).toContain('audio');
  });

  it('接受 FileList 形狀（不只是陣列），因為 e.dataTransfer.files 就是 FileList', () => {
    const f = file('meeting.wav', 'audio/wav');
    const fakeFileList = {
      0: f,
      length: 1,
      item: (i: number) => (i === 0 ? f : null),
      [Symbol.iterator]: function* () { yield f; },
    } as unknown as FileList;
    const result = pickDroppedAudioFile(fakeFileList);
    expect(result).toEqual({ ok: true, file: f });
  });
});
