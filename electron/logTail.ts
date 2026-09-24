/**
 * server 子程序輸出的最後幾行。server 崩潰時把它放進錯誤視窗，使用者看得到原因，
 * 不用去翻 log 檔（完整的輸出另外寫進 userData/logs/server.log）。
 *
 * 輸出是一段段來的，不保證剛好斷在換行上，所以留著未完成的最後一行，等下一段接上。
 */
export interface LogTail {
  push(chunk: string): void;
  lines(): string[];
}

export function createLogTail(maxLines: number): LogTail {
  const kept: string[] = [];
  let partial = '';
  const keep = (line: string) => {
    kept.push(line);
    if (kept.length > maxLines) kept.shift();
  };
  return {
    push(chunk) {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? '';
      for (const line of parts) keep(line);
    },
    lines() {
      return partial === '' ? [...kept] : [...kept, partial].slice(-maxLines);
    },
  };
}
