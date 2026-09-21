import { describe, it, expect } from 'vitest';
import { buildAliasCandidates, completeEmail, parseRosterCsv } from './rosterImport';

const HEADER = 'employee_id,name_zh,alias,title,email,organization,display_names,match_keys';

describe('completeEmail', () => {
  it('沒有網域時補上預設網域', () => {
    expect(completeEmail('philchen', 'liontravel.com')).toBe('philchen@liontravel.com');
  });

  it('已經帶網域時原樣保留，不覆寫', () => {
    expect(completeEmail('sthuang@jwimarketing.com', 'liontravel.com')).toBe('sthuang@jwimarketing.com');
  });
});

describe('buildAliasCandidates', () => {
  it('合併 display_names 與 match_keys，去重且排除 employeeId 本身', () => {
    const result = buildAliasCandidates(
      '4323',
      '陳國煌 | Philchen | 陳國煌 Philchen | Philchen 陳國煌',
      '4323 | 陳國煌 | philchen',
      'Philchen',
    );
    expect(result).not.toContain('4323');
    expect(result).toContain('陳國煌');
    expect(result).toContain('Philchen');
    expect(result).toContain('philchen'); // match_keys 的小寫版本也收，跟 display_names 的原大小寫是不同字串
    expect(result).toContain('陳國煌 Philchen');
    // 去重：'Philchen' 同時出現在 display_names、match_keys 沒有（那邊是小寫）、alias 欄，只收一次
    expect(result.filter((a) => a === 'Philchen')).toHaveLength(1);
  });

  it('alias 欄位是空的時候不會多出一個空字串候選', () => {
    const result = buildAliasCandidates('9999', '王小明', '9999 | 王小明', '');
    expect(result).not.toContain('');
  });

  it('employeeId 大小寫不同也擋得住（防呆，實際資料是純數字或英數混合）', () => {
    const result = buildAliasCandidates('00A385', '周永智 | jimmy', '00a385 | 周永智 | jimmy', 'jimmy');
    expect(result).not.toContain('00a385');
  });
});

describe('parseRosterCsv', () => {
  it('解析出正確的人數與欄位對應', () => {
    const csv = [
      HEADER,
      '4323,陳國煌,Philchen,資深協理,philchen,經營企劃部/通路企劃組,陳國煌 | Philchen,4323 | 陳國煌 | philchen',
      '6036,陳雅婷,Tina,經營企劃,tinachen,經營企劃部/通路企劃組,陳雅婷 | Tina,6036 | 陳雅婷 | tina | tinachen',
    ].join('\n');

    const result = parseRosterCsv(csv, 'liontravel.com');
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      employeeId: '4323',
      displayName: '陳國煌',
      title: '資深協理',
      email: 'philchen@liontravel.com',
      department: '經營企劃部/通路企劃組',
    });
    expect(result.rows[0].aliases).toContain('Philchen');
  });

  it('email 已含網域時不覆寫（子公司的人）', () => {
    const csv = [
      HEADER,
      '00F665,黃詩婷,Tina,系統企劃,sthuang@jwimarketing.com,系統企劃部,黃詩婷 | Tina,00F665 | 黃詩婷 | tina',
    ].join('\n');

    const result = parseRosterCsv(csv, 'liontravel.com');
    expect(result.errors).toEqual([]);
    expect(result.rows[0].email).toBe('sthuang@jwimarketing.com');
  });

  it('title 或 organization 是空字串時存成 null，不是空字串', () => {
    const csv = [
      HEADER,
      '1001,測試人員,,,test1001,,測試人員,1001 | 測試人員',
    ].join('\n');

    const result = parseRosterCsv(csv, 'liontravel.com');
    expect(result.errors).toEqual([]);
    expect(result.rows[0].title).toBeNull();
    expect(result.rows[0].department).toBeNull();
  });

  it('缺表頭欄位時整批拒絕並說明缺哪個欄位', () => {
    const csv = 'employee_id,name_zh,email\n1001,王小明,test@x.com';
    const result = parseRosterCsv(csv, 'liontravel.com');
    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toContain('alias');
  });

  it('employee_id 是空的整批拒絕，不部分寫入', () => {
    const csv = [
      HEADER,
      '4323,陳國煌,Philchen,資深協理,philchen,經營企劃部,陳國煌 | Philchen,4323 | 陳國煌 | philchen',
      ',缺員編的人,,,test,,缺員編的人,test',
    ].join('\n');

    const result = parseRosterCsv(csv, 'liontravel.com');
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('第 3 行');
  });

  it('同一個 employee_id 在檔案裡出現兩次，整批拒絕', () => {
    const csv = [
      HEADER,
      '4323,陳國煌,Philchen,資深協理,philchen,經營企劃部,陳國煌 | Philchen,4323 | 陳國煌 | philchen',
      '4323,另一個人,,,other,,另一個人,4323 | 另一個人',
    ].join('\n');

    const result = parseRosterCsv(csv, 'liontravel.com');
    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toContain('重複');
  });

  it('某一列欄位數與表頭不符時整批拒絕，不猜欄位怎麼對齊', () => {
    const csv = [
      HEADER,
      '4323,陳國煌,Philchen,資深協理,philchen,經營企劃部/通路企劃組,陳國煌 | Philchen', // 少一欄
    ].join('\n');

    const result = parseRosterCsv(csv, 'liontravel.com');
    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toContain('欄位數');
  });

  it('空檔案回報錯誤，不是空陣列成功', () => {
    const result = parseRosterCsv('', 'liontravel.com');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
