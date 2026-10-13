// Extrait le nom et l'adresse d'un lien Google Maps (les liens courts maps.app.goo.gl sont suivis).
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);
const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$|(^|\.)goo\.gl$/;

export async function resolveMapsUrl(url, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const parsed = safeUrl(current);
    if (!parsed || !SHORT_HOSTS.has(parsed.hostname)) return current;
    const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const location = res.headers.get('location');
    if (!location) return current;
    const next = safeUrl(new URL(location, current).href);
    if (!next || !GOOGLE_HOST.test(next.hostname)) return current;
    current = next.href;
  }
  return current;
}

export function parseMapsUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return {};
  let label = null;
  const place = parsed.pathname.match(/\/maps\/place\/([^/]+)/);
  if (place) label = decode(place[1]);
  else label = parsed.searchParams.get('q') || parsed.searchParams.get('query') || null;
  if (!label || /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(label)) return {};
  const [first, ...rest] = label.split(',').map((part) => part.trim());
  // "Boulangerie Dupont, 12 Rue X, 75001 Paris" → nom + adresse ; "12 Rue X, Paris" → adresse seule.
  if (rest.length && !/^\d/.test(first)) return { name: first, address: rest.join(', ') };
  return { address: label };
}

export async function addressFromMapsUrl(url, fetchImpl = fetch) {
  try {
    return parseMapsUrl(await resolveMapsUrl(url, fetchImpl)).address ?? null;
  } catch {
    return null;
  }
}

function decode(segment) {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' ')).trim();
  } catch {
    return segment.replace(/\+/g, ' ').trim();
  }
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
