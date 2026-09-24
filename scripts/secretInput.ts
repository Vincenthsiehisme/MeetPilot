/**
 * 在終端機隱藏輸入一個密值（例如 Blob token），不經過指令列，所以不會進 shell history，
 * 而且 macOS 與 Windows 同一種用法（`VAR=value cmd` 在 cmd／PowerShell 不能用）。
 *
 * 逐鍵處理的規則抽成純函式 `applySecretKeys`，才測得到：Windows 的 Enter 是 `\r`、
 * macOS 是 `\r` 或 `\n`，Backspace 有 `\x7f` 與 `\b` 兩種，貼上會一次來一整串。
 */
export interface SecretInputState {
  value: string;
  done: boolean;
  aborted: boolean;
  /** 方向鍵這類按鍵送的是 ESC [ <參數> <結尾字母>，整段都要吃掉，不能只丟 ESC 留下 `[D` */
  escape: 'none' | 'start' | 'csi';
}

export const INITIAL_SECRET_STATE: SecretInputState = { value: '', done: false, aborted: false, escape: 'none' };

export function applySecretKeys(state: SecretInputState, chunk: string): SecretInputState {
  let { value, done, aborted, escape } = state;
  for (const ch of chunk) {
    if (done || aborted) break;
    if (escape === 'start') {
      escape = ch === '[' ? 'csi' : 'none';
      continue;
    }
    if (escape === 'csi') {
      if (ch >= '@' && ch <= '~') escape = 'none'; // CSI 的結尾字元
      continue;
    }
    if (ch === '\u001b') escape = 'start';
    else if (ch === '\r' || ch === '\n') done = true;
    else if (ch === '\u0003') aborted = true; // Ctrl-C
    else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
    else if (ch >= ' ') value += ch; // 其他控制字元（Tab、NUL 等）不算進值
  }
  return { value, done, aborted, escape };
}

/** 提示並讀一行不回顯的輸入。不是互動式終端（被 pipe、在 CI）就拋，不要安靜地讀到空字串 */
export function promptSecret(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('要在終端機裡互動輸入；非互動環境請改用環境變數'));
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let state = INITIAL_SECRET_STATE;
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      state = applySecretKeys(state, chunk);
      if (state.aborted) {
        finish();
        reject(new Error('已取消'));
      } else if (state.done) {
        finish();
        resolve(state.value.trim());
      }
    };
    stdin.on('data', onData);
  });
}
