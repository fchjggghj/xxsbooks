const CN_DIGITS = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
};

const CN_UNITS = { '十': 10, '百': 100, '千': 1000, '万': 10000 };

// 支持一到万以内常见卷名，例如“第一百零二卷”。
export function chineseToArabic(value) {
  const match = String(value).match(/[零〇一二两三四五六七八九十百千万]+/);
  if (!match) return null;
  const text = match[0];
  let total = 0;
  let section = 0;
  let number = 0;

  for (const char of text) {
    if (Object.hasOwn(CN_DIGITS, char)) {
      number = CN_DIGITS[char];
      continue;
    }
    const unit = CN_UNITS[char];
    if (!unit) return null;
    if (unit === 10000) {
      section += number;
      total += section * unit;
      section = 0;
      number = 0;
    } else {
      section += (number || 1) * unit;
      number = 0;
    }
  }
  return total + section + number;
}

export function volumeSortKey(name) {
  const arabic = String(name).match(/\d+/);
  if (arabic) return Number(arabic[0]);
  return chineseToArabic(name);
}

export function sortVolumeNames(a, b) {
  const ka = volumeSortKey(a);
  const kb = volumeSortKey(b);
  if (ka !== null && kb !== null && ka !== kb) return ka - kb;
  if (ka !== null && kb === null) return -1;
  if (ka === null && kb !== null) return 1;
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true });
}

export function sortByLeadingNumber(a, b) {
  const ma = String(a).match(/^(\d+)/);
  const mb = String(b).match(/^(\d+)/);
  if (ma && mb) {
    const diff = Number(ma[1]) - Number(mb[1]);
    if (diff !== 0) return diff;
  }
  if (ma && !mb) return -1;
  if (!ma && mb) return 1;
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true });
}

export function extractFileOrder(fileName) {
  const arabic = String(fileName).match(/\d+/);
  if (arabic) return Number(arabic[0]);
  return chineseToArabic(fileName) ?? Number.MAX_SAFE_INTEGER;
}

export function arabicToChinese(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 9999) return String(value);
  if (number === 0) return '零';
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const units = ['', '十', '百', '千'];
  const chars = String(number).split('').map(Number);
  let result = '';
  let pendingZero = false;
  for (let index = 0; index < chars.length; index++) {
    const digit = chars[index];
    const unitIndex = chars.length - index - 1;
    if (digit === 0) {
      if (result && chars.slice(index + 1).some((item) => item !== 0)) pendingZero = true;
      continue;
    }
    if (pendingZero) {
      result += '零';
      pendingZero = false;
    }
    result += `${digits[digit]}${units[unitIndex]}`;
  }
  return result.startsWith('一十') ? result.slice(1) : result;
}
