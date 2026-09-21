import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('README roster setup', () => {
  it('記載新安裝與升級都必須先匯入名單，以及可直接執行的命令', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    expect(readme).toContain('全新安裝或升級');
    expect(readme).toContain('npx tsx scripts/importRoster.ts <csv-path>');
    expect(readme).toContain('GET /api/people');
    expect(readme).toContain('ParticipantPicker');
  });
});
