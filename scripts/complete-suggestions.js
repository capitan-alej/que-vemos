// Completa las fichas de las pelis que sugiere la familia desde el sitio.
// Lee Firestore sugerencias/{sugId} (title, uid, name, addedAt) y mantiene data/sugeridas.json:
//   - las sugerencias nuevas se buscan en TMDB y quedan "ok" (ficha completa), "no_encontrado" o "duplicado";
//   - las que el dueño borró de Firestore se quitan del archivo;
//   - si no hay nada nuevo ni borrado, el archivo no se toca (así el workflow no commitea).
//
// Node 20+, sin dependencias npm.
// Variables de entorno requeridas: TMDB_API_KEY, OMDB_API_KEY, FIREBASE_SERVICE_ACCOUNT

const fs = require("fs");
const path = require("path");
const { getAccessToken, listDocs } = require("./notify");
const {
  tmdb, loadGenres, getNowPlayingCine, getProvidersAR, buildPick,
  normTitle, pickTmdbId, loadWeeks,
} = require("./update-picks");

const SUGERIDAS_PATH = path.join(__dirname, "..", "data", "sugeridas.json");

// Documentos de Firestore → [{sugId, query, name, addedAt}], los más viejos primero
// (si dos sugieren lo mismo, el primero queda "ok" y el segundo "duplicado").
function parseSugerencias(documents) {
  const out = [];
  for (const d of documents || []) {
    const f = d.fields || {};
    const query = f.title && f.title.stringValue;
    if (!query) continue;
    out.push({
      sugId: d.name.split("/").pop(),
      query,
      name: (f.name && f.name.stringValue) || "",
      addedAt: (f.addedAt && f.addedAt.timestampValue) || d.createTime || "",
    });
  }
  return out.sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
}

// ¿Esta peli (resultado de TMDB) ya fue recomendada o sugerida? Devuelve el texto para duplicateOf, o null.
function findDuplicate(movie, weeks, okItems) {
  const titles = [normTitle(movie.title), normTitle(movie.original_title)].filter(Boolean);
  for (const w of weeks) {
    for (const p of w.picks || []) {
      const id = pickTmdbId(p);
      const hit = id
        ? id === movie.id
        : titles.includes(normTitle(p.title)) || titles.includes(normTitle(p.original));
      if (hit) return `Semana ${w.weekKey}`;
    }
  }
  const it = okItems.find((x) => x.tmdbId === movie.id);
  if (it) return `sugerida por ${it.suggestedBy || "alguien"}`;
  return null;
}

async function completeOne(sug, weeks, okItems, nowPlayingIds) {
  const base = { sugId: sug.sugId, suggestedBy: sug.name, suggestedAt: sug.addedAt, query: sug.query };
  const j = await tmdb("/search/movie", { query: sug.query, region: "AR" });
  const movie = (j.results || [])[0];
  if (!movie) return { ...base, status: "no_encontrado" };

  const dup = findDuplicate(movie, weeks, okItems);
  if (dup) return { ...base, status: "duplicado", duplicateOf: dup };

  const prov = await getProvidersAR(movie.id);
  let type, venue;
  if (prov.flatrate.length) { type = "plataforma"; venue = prov.flatrate[0].provider_name; }
  else if (nowPlayingIds.has(movie.id)) { type = "cine"; venue = ""; } // buildPick pone "Cines (AR)"
  else { type = "otra"; venue = "Sin plataforma en AR"; }

  const { _score, ...pick } = await buildPick(movie.id, type, venue);
  return { ...base, status: "ok", ...pick };
}

async function main() {
  if (!process.env.TMDB_API_KEY || !process.env.OMDB_API_KEY) {
    throw new Error("Faltan TMDB_API_KEY y/o OMDB_API_KEY como variables de entorno.");
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Falta FIREBASE_SERVICE_ACCOUNT en el entorno.");

  const accessToken = await getAccessToken(JSON.parse(raw));
  const sugs = parseSugerencias(await listDocs(accessToken, "sugerencias"));
  const liveIds = new Set(sugs.map((s) => s.sugId));

  let prev = { items: [] };
  try { prev = JSON.parse(fs.readFileSync(SUGERIDAS_PATH, "utf8")); } catch (e) { /* primera vez */ }
  const kept = (prev.items || []).filter((it) => liveIds.has(it.sugId));
  const removed = (prev.items || []).length - kept.length;
  const known = new Set(kept.map((it) => it.sugId));
  const fresh = sugs.filter((s) => !known.has(s.sugId));

  console.log(`Sugerencias en Firestore: ${sugs.length} · nuevas: ${fresh.length} · borradas: ${removed}`);

  const items = [...kept];
  if (fresh.length) {
    await loadGenres();
    const weeks = loadWeeks();
    const nowPlayingIds = new Set((await getNowPlayingCine()).map((m) => m.id));
    for (const sug of fresh) {
      try {
        const it = await completeOne(sug, weeks, items.filter((x) => x.status === "ok"), nowPlayingIds);
        items.push(it);
        console.log(`  ${it.status}: "${sug.query}"${it.title ? ` → ${it.title}` : ""}${it.duplicateOf ? ` (${it.duplicateOf})` : ""}`);
      } catch (e) {
        // no se agrega: se reintenta en la próxima corrida
        console.error(`  error con "${sug.query}": ${e.message}`);
      }
    }
  }

  if (items.length === kept.length && !removed) {
    console.log("Sin cambios: no se reescribe data/sugeridas.json.");
    return 0;
  }
  fs.writeFileSync(SUGERIDAS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2));
  console.log(`Listo: ${items.length} fichas en data/sugeridas.json.`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => { console.error(e.message || e); process.exit(1); }
  );
}

module.exports = { parseSugerencias, findDuplicate, completeOne, main };
