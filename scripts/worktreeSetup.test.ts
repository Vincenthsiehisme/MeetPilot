import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorktreeEnv, defaultWorktreePath, findFreePort, gitSteps, inheritedIsolationKeys, installStep, parseDotenvValue, portIsFree, staysInside } from './worktreeSetup';

describe('gitSteps', () => {
  const steps = gitSteps({ mainClone: '/dev/App', branch: 'feat/x', path: '/dev/App-x', base: 'origin/main' });

  it('先 fetch 再從 base 開 worktree', () => {
    expect(steps.map((s) => s.args)).toEqual([
      ['fetch', 'origin'],
      ['worktree', 'add', '--no-track', '-b', 'feat/x', '/dev/App-x', 'origin/main'],
    ]);
  });

  it('呼叫端的 clone 不做 checkout、pull、reset、switch', () => {
    for (const s of steps) expect(s.args[0]).not.toMatch(/^(checkout|pull|reset|switch|merge|rebase)$/);
  });
});

describe('installStep', () => {
  it('在新 worktree 裡 npm ci，不在主 clone', () => {
    expect(installStep('/dev/App-x')).toEqual({ command: 'npm', args: ['ci', '--no-audit', '--no-fund'], cwd: '/dev/App-x' });
  });
});

describe('defaultWorktreePath', () => {
  it('放主 clone 旁邊，名字接分支最後一段', () => {
    expect(defaultWorktreePath('/dev/App', 'feat/the-thing')).toBe(join('/dev', 'App-the-thing'));
  });
});

describe('buildWorktreeEnv', () => {
  const source = [
    '# 註解留著',
    'GEMINI_API_KEY=fake-key-123',
    'HOST=127.0.0.1',
    'PORT=3000',
    'MEETPILOT_DB=/Users/someone/data/prod.db',
    'MEETPILOT_AUDIO_DIR=data/audio',
    'MEETPILOT_LLM_LOG="~/logs/llm.jsonl"',
    'MEETPILOT_VAULT=/Users/someone/MeetPilot Vault',
    'export MEETPILOT_BASIC_AUTH_USER=admin',
    '',
  ].join('\n');
  const { text, report } = buildWorktreeEnv(source, { port: 3007, hmrPort: 24690, vaultDir: '/tmp/vault-x', mainClone: '/dev/App', worktree: '/dev/App-x' });
  const lines = text.split('\n');

  it('PORT 與 MEETPILOT_VAULT 一定換成這個 worktree 的值，各只出現一次', () => {
    expect(lines.filter((l) => l.startsWith('PORT='))).toEqual(['PORT=3007']);
    expect(lines.filter((l) => l.startsWith('MEETPILOT_VAULT='))).toEqual(['MEETPILOT_VAULT=/tmp/vault-x']);
    expect(lines.filter((l) => l.startsWith('MEETPILOT_HMR_PORT='))).toEqual(['MEETPILOT_HMR_PORT=24690']);
  });

  it('主 clone 的 MEETPILOT_VAULT、PORT 是空值也丟掉，只留強制寫的那一行', () => {
    const r = buildWorktreeEnv(['MEETPILOT_VAULT=', 'PORT='].join('\n'), { port: 3009, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x' });
    const lines = r.text.split('\n');
    expect(lines.filter((l) => l.startsWith('MEETPILOT_VAULT='))).toEqual(['MEETPILOT_VAULT=/tmp/v']);
    expect(lines.filter((l) => l.startsWith('PORT='))).toEqual(['PORT=3009']);
  });

  it('主 clone 沒設 MEETPILOT_VAULT 也要寫，不然會落到 ~/MeetPilot Vault', () => {
    expect(buildWorktreeEnv('HOST=127.0.0.1', { port: 3001, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x' }).text).toContain('MEETPILOT_VAULT=/tmp/v');
  });

  it('會寫檔的設定是絕對路徑或 ~ 就拿掉，相對路徑留著', () => {
    expect(text).not.toContain('prod.db');
    expect(text).not.toContain('llm.jsonl');
    expect(text).toContain('MEETPILOT_AUDIO_DIR=data/audio');
    expect(report.dropped).toEqual(['MEETPILOT_DB', 'MEETPILOT_LLM_LOG']);
  });

  it('相對路徑跑出 worktree 外也拿掉，留在裡面的照留', () => {
    const r = buildWorktreeEnv(['MEETPILOT_DB=../shared/prod.db', 'MEETPILOT_AUDIO_DIR=data/audio'].join('\n'), {
      port: 3001, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x',
    });
    expect(r.report.dropped).toEqual(['MEETPILOT_DB']);
    expect(r.text).toContain('MEETPILOT_AUDIO_DIR=data/audio');
  });

  it('UNC 與 Windows 根目錄相對路徑算在 worktree 外', () => {
    expect(staysInside('/dev/App-x', '\\\\server\\share\\db')).toBe(false);
    expect(staysInside('/dev/App-x', '\\data\\db')).toBe(false);
    expect(staysInside('/dev/App-x', 'data/db')).toBe(true);
    expect(staysInside('/dev/App-x', '.')).toBe(false);
  });

  it('Windows 磁碟機路徑也算絕對路徑', () => {
    expect(buildWorktreeEnv('MEETPILOT_DB=C:\\data\\prod.db', { port: 3001, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x' }).report.dropped).toEqual(['MEETPILOT_DB']);
  });

  it('寫入設定是空值就原樣留（等同用預設），不報成指到 worktree 外', () => {
    const r = buildWorktreeEnv('MEETPILOT_DB=', { port: 3001, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x' });
    expect(r.report.dropped).toEqual([]);
    expect(r.report.copied).toEqual(['MEETPILOT_DB']);
  });

  it('LLM log 設成 off 照留', () => {
    expect(buildWorktreeEnv('MEETPILOT_LLM_LOG=off', { port: 3001, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x' }).text).toContain('MEETPILOT_LLM_LOG=off');
  });

  it('只讀的輸入檔若是相對路徑，改指回主 clone；絕對路徑與不是路徑的值原樣留', () => {
    const r = buildWorktreeEnv(
      ['MEETPILOT_ROSTER_CSV=eval-data/roster.csv', 'MEETPILOT_FFMPEG=/opt/bin/ffmpeg', 'MEETPILOT_FFPROBE=ffprobe'].join('\n'),
      { port: 3001, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x' },
    );
    expect(r.text).toContain(`MEETPILOT_ROSTER_CSV=${join('/dev/App', 'eval-data/roster.csv')}`);
    expect(r.text).toContain('MEETPILOT_FFMPEG=/opt/bin/ffmpeg');
    expect(r.text).toContain('MEETPILOT_FFPROBE=ffprobe');
    expect(r.report.repointed).toEqual(['MEETPILOT_ROSTER_CSV']);
  });

  it('其他 key 與註解原樣複製', () => {
    expect(text).toContain('# 註解留著');
    expect(text).toContain('GEMINI_API_KEY=fake-key-123');
    expect(text).toContain('export MEETPILOT_BASIC_AUTH_USER=admin');
    expect(report.copied).toEqual(['GEMINI_API_KEY', 'HOST', 'MEETPILOT_AUDIO_DIR', 'MEETPILOT_BASIC_AUTH_USER']);
  });

  it('報告只有 key 名，不含任何值', () => {
    const flat = JSON.stringify(report);
    for (const secret of ['fake-key-123', 'admin', 'prod.db', '127.0.0.1']) expect(flat).not.toContain(secret);
  });
});

describe('portIsFree', () => {
  it('別人綁在 0.0.0.0 或 ::1 的 port 也不算空的', async () => {
    for (const host of ['0.0.0.0', '::1']) {
      const server = createServer();
      await new Promise<void>((done) => server.listen(0, host, () => done()));
      const taken = (server.address() as { port: number }).port;
      try {
        expect(await portIsFree(taken)).toBe(false);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    }
  });

  it('別人綁在所有介面的 port 不算空的（只探 127.0.0.1 會看不到）', async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, () => done()));
    const taken = (server.address() as { port: number }).port;
    try {
      expect(await portIsFree(taken)).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('findFreePort', () => {
  it('被佔用的 port 會跳過', async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const taken = (server.address() as { port: number }).port;
    try {
      const port = await findFreePort(taken, 5);
      expect(port).not.toBe(taken);
      expect(port).toBeGreaterThan(taken);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('inheritedIsolationKeys', () => {
  it('shell 已經 export 的隔離 key 列出來（只有 key 名），空字串不算', () => {
    expect(inheritedIsolationKeys({ MEETPILOT_DB: '/x/prod.db', PORT: '3000', MEETPILOT_VAULT: ' ', HOME: '/h' })).toEqual(['MEETPILOT_DB', 'PORT']);
    expect(inheritedIsolationKeys({ HOME: '/h' })).toEqual([]);
  });
});

describe('parseDotenvValue', () => {
  it('引號值取到收尾引號，後面的註解不算', () => {
    expect(parseDotenvValue('"/prod/db.sqlite" # production')).toBe('/prod/db.sqlite');
    expect(parseDotenvValue("'a b' # x")).toBe('a b');
  });

  it('沒引號就切掉 # 之後的註解', () => {
    expect(parseDotenvValue('data/db.sqlite # 本機')).toBe('data/db.sqlite');
    expect(parseDotenvValue('  plain  ')).toBe('plain');
  });
});

describe('buildWorktreeEnv 的 dotenv 語意', () => {
  const o = { port: 3001, hmrPort: 24680, vaultDir: '/tmp/v', mainClone: '/dev/App', worktree: '/dev/App-x' };

  it('引號加行尾註解的絕對寫入路徑照樣拿掉', () => {
    expect(buildWorktreeEnv('MEETPILOT_DB="/prod/db.sqlite" # production', o).report.dropped).toEqual(['MEETPILOT_DB']);
  });

  it('沒有斜線的相對輸入檔也改指回主 clone，ffmpeg 的裸命令名稱例外', () => {
    const r = buildWorktreeEnv(['MEETPILOT_ROSTER_CSV=roster.csv', 'MEETPILOT_FFMPEG=ffmpeg'].join('\n'), o);
    expect(r.text).toContain(`MEETPILOT_ROSTER_CSV=${join('/dev/App', 'roster.csv')}`);
    expect(r.text).toContain('MEETPILOT_FFMPEG=ffmpeg');
    expect(r.report.repointed).toEqual(['MEETPILOT_ROSTER_CSV']);
  });
});
