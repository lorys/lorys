const API = "https://api.alldebrid.com/v4";
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(endpoint, params = {}) {
  const apiKey = process.env.ALLDEBRID_API_KEY;
  if (!apiKey) throw new Error("ALLDEBRID_API_KEY n'est pas défini");

  const res = await fetch(`${API}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: new URLSearchParams(params),
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Réponse invalide d'AllDebrid (HTTP ${res.status})`);
  }

  if (json.status !== "success") {
    const { code, message } = json.error ?? {};
    throw new Error(`AllDebrid ${code ?? res.status}: ${message ?? "erreur inconnue"}`);
  }
  return json.data;
}

/**
 * Débride un lien via AllDebrid et renvoie le lien de téléchargement direct.
 * @param {string} name Movie's name
 * @returns {Promise<{ link: string, filename: string, filesize: number }>}
 */
export async function addASerie(name, season = 1) {
    const ztdomain = await (async () => {
        const source = await fetch(process.env.GET_ZT_URL);
        const data = await source.text();
        const reg = new RegExp(process.env.ZT_REG, "g");
        return data.match(reg)[0];
    })();
    console.log({ ztdomain });

    console.log("Fetching ", `https://${ztdomain}/?p=series&search=${name}`);
    const searchQ = await fetch(`https://${ztdomain}/?p=series&search=${name}`);
    const searchResult = await searchQ.text();
    const allResults = (Array.from(searchResult.matchAll(/<a href="\?p=serie(?:&amp;|&)id=([^"]*)"/g))).map(e => e[1]);
    console.log(JSON.stringify({ allResults }, null, 2));
    if (!allResults || !allResults.length)
        return { ok: false, error: 'not found' };

    const serieQ = await fetch(`https://${ztdomain}/?p=serie&id=${allResults[0]}`);
    const serieData = await serieQ.text();

    const rawSerieName = Array.from(serieData.matchAll(/<div style="font-family: 'Ubuntu Condensed','Segoe UI',Verdana,Helvetica,sans-serif;font-size: 24px;letter-spacing: 0\.05em;color: #ff4d00;font-weight: bold;text-align: center;margin: 25px;">([^<]{0,})<\/div>/g));
    const serieName = rawSerieName?.[0]?.[1];
        
    let imgUrl = null;

    const allSeasons = Array.from(serieData.matchAll(/(?<=Saisons également disponibles pour cette série:(?:(?!Qualités également disponibles pour cette série:)[\s\S])*?)<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)).map(e => [e[1].replaceAll('&amp;', '&'), e[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()]);

    const allWantedSeasons = allSeasons.filter(e => e[1].indexOf('(VOSTFR)') > -1);

    const currentPageSeason = Number(serieData.match(/Episodes\s*\|\s*Saison\s*(\d+)/i)?.[1]);
    const currentPageAvailableQualities = Array.from(serieData.matchAll(/(?<=Qualités également disponibles pour cette série:(?:(?!<\/div>)[\s\S])*?)<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)).map(e => [e[1].replaceAll('&amp;', '&'), e[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()]);
    const currentPageQuality = serieData.match(/<\/span>\s*([^<]+?)\s*<br\s*\/?>/i)?.[1].trim();
    
    console.log(JSON.stringify({
      serieName,
      allSeasons,
      allWantedSeasons,
      currentPageSeason,
      currentPageAvailableQualities,
      currentPageQuality
    }, null, 2));

    let allDownloadLinks = [];

    let foundSeason = allWantedSeasons.find(e => e[1].indexOf(`Saison ${season}`));
    if (foundSeason) {
      const wantedSeasonQ = await fetch(`https://${ztdomain}/${foundSeason[0]}`);
      const wantedSeasonData = await wantedSeasonQ.text();

      const imgUrlRaw = Array.from(wantedSeasonData.matchAll(/<center>[^<]{0,}<img src="([^"]{0,})" alt="/g));
      let imgUrl = imgUrlRaw?.[0]?.[1];
      const reqImg = await fetch(`https://${ztdomain}${imgUrl}`);
      const buffer = Buffer.from(await reqImg.arrayBuffer());
      const mime = reqImg.headers.get("content-type") || "image/png";
      imgUrl = `data:${mime};base64,${buffer.toString("base64")}`;

      allDownloadLinks = [
        ...(Array.from(wantedSeasonData.matchAll(/(?<=Rapidgator(?:(?!<br\s*\/>)[\s\S])*?)<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)).map(m => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').trim()])),
        ...(Array.from(wantedSeasonData.matchAll(/(?<=Nitroflare(?:(?!<br\s*\/>)[\s\S])*?)<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)).map(m => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').trim()]))
      ];
    } else if (currentPageSeason === season && currentPageQuality.indexOf('VOSTFR')) {
      allDownloadLinks = [
        ...(Array.from(wantedSeasonData.matchAll(/(?<=Rapidgator(?:(?!<br\s*\/>)[\s\S])*?)<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)).map(m => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').trim()])),
        ...(Array.from(wantedSeasonData.matchAll(/(?<=Nitroflare(?:(?!<br\s*\/>)[\s\S])*?)<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)).map(m => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').trim()]))
      ];
    }

    let foundRightQuality = currentPageAvailableQualities.find(e => e[1].indexOf('VOSTFR'));
    if (!allDownloadLinks.length && currentPageSeason === season && foundRightQuality) {
      const wantedQualityQ = await fetch(`https://${ztdomain}/${foundRightQuality[0]}`);
      const wantedQualityData = await wantedQualityQ.text();
      allDownloadLinks = [
        ...(Array.from(wantedQualityData.matchAll(/(?<=Rapidgator(?:(?!<br\s*\/>)[\s\S])*?)<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)).map(m => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').trim()])),
        ...(Array.from(wantedQualityData.matchAll(/(?<=Nitroflare(?:(?!<br\s*\/>)[\s\S])*?)<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)).map(m => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').trim()]))
      ];
    }

    if (!allDownloadLinks.length)
        return { ok: false, error: 'not found' };

    console.log({ allDownloadLinks });
    
    allDownloadLinks = allDownloadLinks.reduce((acc, item) => ({
      ...acc,
      [item[0]]: [ ...(acc?.[item[0]] || []), item[1] ]
    }), ({ }));

    console.log({ allDownloadLinks });

    if (currentPageSeason === season) {
      const imgUrlRaw = Array.from(serieData.matchAll(/<center>[^<]{0,}<img src="([^"]{0,})" alt="/g));
      let imgUrl = imgUrlRaw?.[0]?.[1];
      const reqImg = await fetch(`https://${ztdomain}${imgUrl}`);
      const buffer = Buffer.from(await reqImg.arrayBuffer());
      const mime = reqImg.headers.get("content-type") || "image/png";
      imgUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    }

    return {
        serieName,
        imgUrl,
        download: async () => {
            const results = await Promise.allSettled(Object.keys(allDownloadLinks).map(async episode => {
              for (let i = 0; allDownloadLinks[episode][i]; i++) {
                const url = allDownloadLinks[episode];
                try {
                    let links;
                    try {
                      const data = await api("/link/redirector", { link: url });
                      links = data.links;
                    } catch (e) {
                      // Pas un redirector : on traite l'URL comme un lien d'hébergeur classique
                      if (!/REDIRECTOR_NOT_SUPPORTED/.test(e.message)) throw e;
                      links = [url];
                    }

                    const data = await api("/link/unlock", { link: links[0] });

                    // Lien direct disponible immédiatement
                    if (data.link) {
                      return { link: data.link, filename: data.filename, filesize: data.filesize };
                    }

                    // Lien "delayed" : il faut poller /link/delayed jusqu'à ce qu'il soit prêt
                    if (data.delayed) {
                      const start = Date.now();
                      while (Date.now() - start < MAX_WAIT_MS) {
                        await sleep(POLL_INTERVAL_MS);
                        const d = await api("/link/delayed", { id: data.delayed });
                        if (d.status === 2) {
                          return { link: d.link, filename: data.filename, filesize: data.filesize };
                        }
                        if (d.status === 3) {
                          throw new Error("AllDebrid n'a pas pu générer le lien de téléchargement");
                        }
                      }
                      throw new Error("Délai dépassé en attendant le lien AllDebrid");
                    }

                    // Cas des streams à plusieurs qualités (data.streams) : non géré ici
                    throw new Error("Aucun lien direct renvoyé (stream à plusieurs qualités ?)");
                } catch (err) {
                    console.log("❌ Couldn't download", url, err);
                }
              }
            }));

            return results.filter(e => e.status === 'fulfilled').map(e => e.value);
        }
    };
}
