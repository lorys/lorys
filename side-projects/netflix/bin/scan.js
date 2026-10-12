// Manually sync MOVIES_INFOS_PATH. The server already does this automatically;
// use `--force` to refresh every movie from TMDB (e.g. after a bad match).
import { loadConfig } from '../src/config.js';
import { scanMovies } from '../src/scanner.js';

const force = process.argv.includes('--force');
const stats = await scanMovies(loadConfig(), { force });
console.log(
  `${stats.total} fichiers (${stats.shows} séries), ${stats.lookedUp} recherchés sur TMDB: ${stats.matched} trouvés, ` +
    `${stats.unmatched} sans résultat, ${stats.errors} erreurs, ${stats.removed} supprimés`,
);
