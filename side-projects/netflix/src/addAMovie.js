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
    const allResults = (Array.from(searchResult.matchAll(/<a href="\?p=film(?:&amp;|&)id=([^"]*)"/g))).map(e => e[1]);
    const first10Result = allResults?.slice(0,10);

    console.log({ first10Result });

    if (!first10Result || !first10Result.length)
        return { ok: false, error: 'not found' };

    const getMovieDataFromPage = async (ztcontent) => {
        
        const rawMovieName = Array.from(ztcontent.matchAll(/<div style="font-family: 'Ubuntu Condensed','Segoe UI',Verdana,Helvetica,sans-serif;font-size: 24px;letter-spacing: 0\.05em;color: #ff4d00;font-weight: bold;text-align: center;margin: 25px;">([^<]{0,})<\/div>/g));
        const movieName = rawMovieName?.[0]?.[1];
        
        const imgUrlRaw = Array.from(ztcontent.matchAll(/<center>[^<]{0,}<img src="([^"]{0,})" alt="/g));
        let imgUrl = imgUrlRaw?.[0]?.[1];
        const reqImg = await fetch(`https://${ztdomain}${imgUrl}`);
        const buffer = Buffer.from(await reqImg.arrayBuffer());
        const mime = reqImg.headers.get("content-type") || "image/png";
        imgUrl = `data:${mime};base64,${buffer.toString("base64")}`;

        const rawSize = Array.from(ztcontent.matchAll(/<strong>[^<]{0,}<u>Taille du fichier<\/u>[^<]{0,}:[^<]{0,}<\/strong>[\D]{0,}([^G]{0,}Go)/g));
        const size = rawSize?.[0]?.[1];

        const allQualityLinks = Array.from(ztcontent.matchAll(/(?<=Qualités également disponibles pour ce film:(?:(?!<\/div>)[\s\S])*?<a\b[^>]*\bhref=["'])[^"']+/g))?.map(e => e?.[0]);

        const protectedDownloadLinks = [
            Array.from(ztcontent.matchAll(/(?<=<b><div style="font-weight:bold;color:#fbaf4e">Rapidgator<\/div><\/b>(?:(?!<a\b)[\s\S])*?<a\b[^>]*href=["'])[^"']+/g))?.map(e => e?.[0])?.[0],
            Array.from(ztcontent.matchAll(/(?<=<b><div style="font-weight:bold;color:#c2107b">Uploady<\/div><\/b>(?:(?!<a\b)[\s\S])*?<a\b[^>]*href=["'])[^"']+/g))?.map(e => e?.[0])?.[0],
            Array.from(ztcontent.matchAll(/(?<=<b><div style="font-weight:bold;color:#c442b5">DailyUploads<\/div><\/b>(?:(?!<a\b)[\s\S])*?<a\b[^>]*href=["'])[^"']+/g))?.map(e => e?.[0])?.[0],
            Array.from(ztcontent.matchAll(/(?<=<b><div style="font-weight:bold;color:#f47445">Turbobit<\/div><\/b>(?:(?!<a\b)[\s\S])*?<a\b[^>]*href=["'])[^"']+/g))?.map(e => e?.[0])?.[0],
            Array.from(ztcontent.matchAll(/(?<=<b><div style="font-weight:bold;color:#5390a8">Nitroflare<\/div><\/b>(?:(?!<a\b)[\s\S])*?<a\b[^>]*href=["'])[^"']+/g))?.map(e => e?.[0])?.[0]
        ];        

        console.log(JSON.stringify({ protectedDownloadLinks }, null, 2));

        return {
            movieName,
            imgUrl,
            size,
            allQualityLinks,
            protectedDownloadLinks
        }
    };

    const getBestQualities = async (movieId) => {
        const movieQ = await fetch(`https://${ztdomain}/?p=film&id=${movieId}`);
        const movieData = await movieQ.text();
        let currentMovieData = await getMovieDataFromPage(movieData);
        console.log({ currentMovieData });

        const allQualities = await Promise.allSettled(currentMovieData.allQualityLinks.map(async (e) => {
            console.log("allQualities", e, "fetching...");
            const movieQ = await fetch(`https://${ztdomain}/${e}`);
            const movieData = await movieQ.text();
            return await getMovieDataFromPage(movieData);
        }));

        let allAvailableQualities = [currentMovieData, ...(allQualities.map(e => e.value))];
        allAvailableQualities.sort((a, b) => parseFloat(a.size) - parseFloat(b.size));

        let bestQuality = allAvailableQualities.find(e => parseFloat(e.size) > 2 && parseFloat(e.size) < 5);

        return bestQuality || allAvailableQualities[0];
    };

    const results = await Promise.allSettled(first10Result.map(getBestQualities));

    return results.filter(e => e.status === 'fulfilled').map(res => ({
        movieName: res.value.movieName,
        imgUrl: res.value.imgUrl,
        size: res.value.size,
        download: async () => {
            for (let a = 0; a < res.value.protectedDownloadLinks.length; a++) {
                const url = res.value.protectedDownloadLinks[a];
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

                    console.log("LINKS >", links);

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
        }
    }));
}
