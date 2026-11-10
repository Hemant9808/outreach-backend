const LEGAL_SUFFIXES = [
  'private limited',
  'pvt ltd',
  'pvt',
  'limited',
  'ltd',
  'llp',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'pte',
  'sa',
  'ag',
  'bv',
];

const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.in',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'zohomail.in',
  'zohomail.com',
  'yandex.com',
  'gmx.com',
  'mail.com',
]);

export function cleanCompanyName(name?: string | null): string | null {
  const cleaned = name?.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

export function companyKey(name: string): string {
  let key = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (key.endsWith(` ${suffix}`)) {
        key = key.slice(0, -suffix.length - 1).trim();
        changed = true;
      }
    }
  }
  return key.replace(/ /g, '') || name.toLowerCase();
}

export function domainFromUrl(value?: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

export function companyDomainFromEmail(email?: string | null): string | null {
  const domain = email?.split('@')[1]?.toLowerCase().trim();
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  return domain;
}
