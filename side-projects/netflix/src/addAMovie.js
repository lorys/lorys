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
export async function addAMovie(name) {
    const ztdomain = await (async () => {
        const source = await fetch(process.env.GET_ZT_URL);
        const data = await source.text();
        const reg = new RegExp(process.env.ZT_REG, "g");
        return data.match(reg)[0];
    })();
    console.log({ ztdomain });

    console.log("Fetching ", `https://${ztdomain}/?p=films&search=${name}`);
    const searchQ = await fetch(`https://${ztdomain}/?p=films&search=${name}`);
    const searchResult = await searchQ.text();
    const allResults = Array.from(searchResult.matchAll(/<a href="\?p=film(?:&amp;|&)id=([^"]*)"/g));
    console.log("allResults", allResults.map(e => e[1]));
    const firstResult = allResults?.[0]?.[1];

    console.log({ firstResult });

    if (!firstResult)
        return { ok: false, error: 'not found' };

    console.log("fetching first result", `https://${ztdomain}/?p=film&id=${firstResult}`);
    const movieQ = await fetch(`https://${ztdomain}/?p=film&id=${firstResult}`);
    const movieData = await movieQ.text();

    const getMovieDataFromPage = (ztcontent) => {
        const rawMovieName = Array.from(ztcontent.matchAll(/<div style="font-family: 'Ubuntu Condensed','Segoe UI',Verdana,Helvetica,sans-serif;font-size: 24px;letter-spacing: 0\.05em;color: #ff4d00;font-weight: bold;text-align: center;margin: 25px;">([^<]{0,})<\/div>/g));
        console.log({ rawMovieName });
        const movieName = rawMovieName[0][1];
        const imgUrlRaw = Array.from(ztcontent.matchAll(/<center>[^<]{0,}<img src="([^"]{0,})" alt="/g));
        console.log({ imgUrlRaw });
        const imgUrl = imgUrlRaw[0][1];
        const rawSize = Array.from(ztcontent.matchAll(/<strong>[^<]{0,}<u>Taille du fichier<\/u>[^<]{0,}:[^<]{0,}<\/strong>[\D]{0,}([^G]{0,}Go)/g));
        console.log({ rawSize });
        const size = rawSize[0][1];
        const allQualityLinks = Array.from(ztcontent.matchAll(/(?<=Qualités également disponibles pour ce film:(?:(?!<\/div>)[\s\S])*?<a\b[^>]*\bhref=["'])[^"']+/g))?.map(e => e?.[0]);
        const protectedDownloadLink = Array.from(ztcontent.matchAll(/(?<=<b><div style="font-weight:bold;color:#fbaf4e">Rapidgator<\/div><\/b>(?:(?!<a\b)[\s\S])*?<a\b[^>]*href=["'])[^"']+/g))?.map(e => e?.[0])?.[0];

        return {
            movieName,
            imgUrl,
            size,
            allQualityLinks,
            protectedDownloadLink
        }
    };

    let currentMovieData = getMovieDataFromPage(movieData);
    console.log({ currentMovieData });

    const allQualities = Promise.allSettled(currentMovieData.allQualityLinks.map(async (e) => {
        console.log("allQualities", e, "fetching...");
        const movieQ = await fetch(`https://${ztdomain}/${e}`);
        const movieData = await movieQ.text();
        return getMovieDataFromPage(movieData);
    }));

    console.log({ allQualities });

    let allAvailableQualities = [currentMovieData, ...allQualities];
    allAvailableQualities.sort((a, b) => parseFloat(a.size) - parseFloat(b.size));

    let bestQuality = allAvailableQualities.find(e => parseFloat(e.size) > 1.5 && parseFloat(e.size) < 5);

    bestQuality = bestQuality || allAvailableQualities[0];

    return {
        movieName: bestQuality.movieName,
        imgUrl: bestQuality.imgUrl,
        size: bestQuality.size,
        download: async () => {
            const data = await api("/link/unlock", { link: bestQuality.protectedDownloadLink });

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
        }
    };
}
