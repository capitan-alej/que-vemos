// Actualiza automáticamente data/current.json, data/archive/*.json y data/archive-index.json
// para el sitio "¿Qué vemos?", usando datos gratuitos de TMDB + OMDb (sin IA, sin costo).
//
// Requiere Node 18+ (usa fetch global). No tiene dependencias npm.
// Variables de entorno requeridas: TMDB_API_KEY, OMDB_API_KEY

const fs = require("fs");
const path = require("path");

const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;

const DATA_DIR = path.join(__dirname, "..", "data");
const CURRENT_PATH = path.join(DATA_DIR, "current.json");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const ARCHIVE_INDEX_PATH = path.join(DATA_DIR, "archive-index.json");
const SUGERIDAS_PATH = path.join(DATA_DIR, "sugeridas.json");

const TMDB_BASE = "https://api.themoviedb.org/3";
const REGION = "AR";
const LANG = "es-AR";

// --- utilidades TMDB/OMDb ---------------------------------------------

async function tmdb(pathname, params = {}) {
  const url = new URL(TMDB_BASE + pathname);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", LANG);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${pathname} -> ${res.status}`);
  return res.json();
}

async function omdb(imdbId) {
  if (!imdbId) return null;
  const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  if (j.Response === "False") return null;
  return j;
}

function ratingFrom(omdbData, sourceName) {
  if (!omdbData || !omdbData.Ratings) return null;
  const r = omdbData.Ratings.find((x) => x.Source === sourceName);
  return r ? r.Value : null;
}

// --- géneros -------------------------------------------------------------

let GENRE_MAP = {};
async function loadGenres() {
  const j = await tmdb("/genre/movie/list");
  GENRE_MAP = Object.fromEntries(j.genres.map((g) => [g.id, g.name]));
}
function genreNames(ids) {
  return (ids || []).map((id) => GENRE_MAP[id]).filter(Boolean);
}

// --- construir el pool de candidatos --------------------------------------

async function getNowPlayingCine() {
  const j = await tmdb("/movie/now_playing", { region: REGION, page: 1 });
  return j.results || [];
}

async function getTrendingPool() {
  const j = await tmdb("/trending/movie/week");
  const j2 = await tmdb("/movie/popular", { region: REGION, page: 1 });
  // página 2 de popular: reserva por si el historial deja corto el pool de plataforma
  const j3 = await tmdb("/movie/popular", { region: REGION, page: 2 });
  const seen = new Map();
  for (const m of [...(j.results || []), ...(j2.results || []), ...(j3.results || [])]) {
    if (!seen.has(m.id)) seen.set(m.id, m);
  }
  return [...seen.values()];
}

async function getProvidersAR(movieId) {
  const j = await tmdb(`/movie/${movieId}/watch/providers`);
  const ar = j.results && j.results.AR;
  if (!ar) return { flatrate: [] };
  return { flatrate: ar.flatrate || [] };
}

async function getDetails(movieId) {
  const j = await tmdb(`/movie/${movieId}`, { append_to_response: "external_ids,credits" });
  return j;
}

function directorFrom(details) {
  const crew = (details.credits && details.credits.crew) || [];
  const directors = crew.filter((c) => c.job === "Director").map((c) => c.name);
  return directors.join(", ");
}

// --- score combinado -------------------------------------------------------

function num(v) {
  // primer número del texto: "67/100" → 67, "7.3/10" → 7.3, "93%" → 93, "N/A" → null
  const m = String(v).match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function combinedScore({ tmdbAvg, tmdbVotes, rt, metascore, imdbRating }) {
  const parts = [];
  if (tmdbAvg != null) parts.push({ v: tmdbAvg, w: Math.min(3, Math.log10((tmdbVotes || 1) + 1)) });
  if (rt != null) parts.push({ v: rt / 10, w: 2 });
  if (metascore != null) parts.push({ v: metascore / 10, w: 2 });
  if (imdbRating != null) parts.push({ v: imdbRating, w: 1.5 });
  if (!parts.length) return null;
  const totalW = parts.reduce((s, p) => s + p.w, 0);
  return parts.reduce((s, p) => s + p.v * p.w, 0) / totalW;
}

function formatVotes(n) {
  if (n == null) return "";
  if (n >= 1000) return Math.round(n / 100) / 10 + "k";
  return String(n);
}

// --- armar un pick a partir de un movieId --------------------------------

async function buildPick(movieId, type, venueOverride) {
  const details = await getDetails(movieId);
  const imdbId = details.external_ids && details.external_ids.imdb_id;
  const om = await omdb(imdbId);

  const rt = num(ratingFrom(om, "Rotten Tomatoes"));
  const meta = num(ratingFrom(om, "Metacritic"));
  const imdbRating = num(ratingFrom(om, "Internet Movie Database"));
  const score10 = combinedScore({
    tmdbAvg: details.vote_average,
    tmdbVotes: details.vote_count,
    rt, metascore: meta, imdbRating,
  });

  const breakdown = [];
  if (details.vote_average) breakdown.push(`TMDB ${details.vote_average.toFixed(1)}`);
  if (rt != null) breakdown.push(`RT ${rt}%`);
  if (meta != null) breakdown.push(`Metascore ${meta}`);
  breakdown.push(`${formatVotes(details.vote_count)} votos`);

  const duration = details.runtime || (om && om.Runtime ? num(om.Runtime) : null);

  const sources = [{ label: "TMDB", url: `https://www.themoviedb.org/movie/${movieId}` }];
  if (imdbId) sources.push({ label: "IMDb", url: `https://www.imdb.com/title/${imdbId}/` });

  return {
    title: details.title,
    original: details.original_title !== details.title ? details.original_title : "",
    director: directorFrom(details),
    type,
    genre: genreNames(details.genres ? details.genres.map((g) => g.id) : details.genre_ids) [0] || "",
    duration: duration || null,
    venue: venueOverride || "Cines (AR)",
    criticLabel: "Puntaje combinado",
    criticScore: breakdown.join(" · "),
    scoreLabel: "Puntaje combinado",
    lbScore: score10 != null ? Math.round((score10 / 2) * 100) / 100 : null,
    lbCount: formatVotes(details.vote_count) + (details.vote_count ? " votos" : ""),
    posterUrl: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : "",
    sources,
    tmdbId: Number(movieId),
    _score: score10 || 0,
  };
}

// --- historial: lo ya recomendado no se repite ----------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

// minúsculas, sin acentos, sin puntuación
function normTitle(t) {
  return String(t || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// tmdbId del pick; los viejos no lo tienen y se saca del link de TMDB en sources
function pickTmdbId(p) {
  if (p.tmdbId) return Number(p.tmdbId);
  for (const s of p.sources || []) {
    const m = String(s.url || "").match(/themoviedb\.org\/movie\/(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

// Semanas publicadas: las archivadas (según archive-index.json) + current.json.
function loadWeeks() {
  const weeks = [];
  for (const key of readJson(ARCHIVE_INDEX_PATH, [])) {
    const w = readJson(path.join(ARCHIVE_DIR, `${key}.json`), null);
    if (w) weeks.push(w);
  }
  const cur = readJson(CURRENT_PATH, null);
  if (cur) weeks.push(cur);
  return weeks;
}

// ids y títulos ya usados. Si current.json es la misma semana que se regenera, no cuenta.
function loadUsed(weekKey) {
  const used = { ids: new Set(), titles: new Set() };
  const add = (p) => {
    const id = pickTmdbId(p);
    if (id) { used.ids.add(id); return; }
    for (const t of [p.title, p.original]) if (normTitle(t)) used.titles.add(normTitle(t));
  };
  for (const w of loadWeeks()) {
    if (w.weekKey === weekKey) continue;
    for (const p of w.picks || []) add(p);
  }
  for (const it of readJson(SUGERIDAS_PATH, { items: [] }).items || []) add(it);
  return used;
}

function isUsed(used, m) {
  return used.ids.has(Number(m.id)) ||
    used.titles.has(normTitle(m.title)) || used.titles.has(normTitle(m.original_title));
}

// --- semana anclada al jueves --------------------------------------------

// Último jueves <= ahora, en hora Argentina (UTC-3, sin horario de verano).
// Devuelve la fecha local a medianoche, que es lo que esperan isoWeekKey / weekLabelFor.
function thursdayAnchor(now = new Date()) {
  const art = new Date(now.getTime() - 3 * 3600 * 1000);
  const back = (art.getUTCDay() - 4 + 7) % 7;
  return new Date(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate() - back);
}

// --- main ------------------------------------------------------------------

async function main(now = new Date()) {
  if (!TMDB_KEY || !OMDB_KEY) {
    console.error("Faltan TMDB_API_KEY y/o OMDB_API_KEY como variables de entorno.");
    process.exit(1);
  }

  // weekKey / weekLabel salen del jueves de la semana, no del día de la corrida
  const anchor = thursdayAnchor(now);
  const weekKey = isoWeekKey(anchor);
  const weekLabel = weekLabelFor(anchor);
  const used = loadUsed(weekKey);

  await loadGenres();

  // 1) candidatos de cine (sin lo ya recomendado)
  const nowPlaying = await getNowPlayingCine();
  const cineCandidates = nowPlaying.filter((m) => !isUsed(used, m)).slice(0, 10);

  // 2) candidatos de plataforma: del pool de trending/popular, los que tengan flatrate en AR
  const pool = await getTrendingPool();
  const platCandidates = [];
  for (const m of pool.filter((m) => !isUsed(used, m))) {
    const prov = await getProvidersAR(m.id);
    if (prov.flatrate.length) {
      platCandidates.push({ movie: m, venue: prov.flatrate[0].provider_name });
    }
    if (platCandidates.length >= 12) break;
  }

  // 3) armar picks con score combinado
  const cinePicks = [];
  for (const m of cineCandidates) {
    try { cinePicks.push(await buildPick(m.id, "cine")); } catch (e) { console.error("cine", m.id, e.message); }
  }
  const platPicks = [];
  for (const { movie, venue } of platCandidates) {
    try { platPicks.push(await buildPick(movie.id, "plataforma", venue)); } catch (e) { console.error("plat", movie.id, e.message); }
  }

  cinePicks.sort((a, b) => b._score - a._score);
  platPicks.sort((a, b) => b._score - a._score);

  // 4) selección final: plataforma siempre >= 2, cine puede ser 0+, total 3-4
  const chosenPlat = platPicks.slice(0, Math.max(2, Math.min(3, platPicks.length)));
  while (chosenPlat.length < 2 && platPicks.length > chosenPlat.length) {
    chosenPlat.push(platPicks[chosenPlat.length]);
  }
  const remainingSlots = Math.max(0, 4 - chosenPlat.length);
  // una peli que está en cines y en plataforma a la vez no sale dos veces
  const platIds = new Set(chosenPlat.map((p) => p.tmdbId));
  const chosenCine = cinePicks.filter((p) => !platIds.has(p.tmdbId)).slice(0, Math.min(remainingSlots, 2));

  const picks = [...chosenPlat, ...chosenCine].map((p) => {
    const { _score, ...rest } = p;
    return rest;
  });

  if (picks.filter((p) => p.type === "plataforma").length < 2) {
    console.error("No se encontraron suficientes candidatos de plataforma (mínimo 2). Revisar API keys / región.");
    process.exit(1);
  }

  // 5) armar la semana
  const newData = {
    weekKey,
    weekLabel,
    generatedAt: now.toISOString(),
    picks,
  };

  // 6) archivar la semana vieja (si existe y es distinta)
  if (fs.existsSync(CURRENT_PATH)) {
    const old = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
    if (old.weekKey && old.weekKey !== weekKey) {
      if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.writeFileSync(path.join(ARCHIVE_DIR, `${old.weekKey}.json`), JSON.stringify(old, null, 2));

      let index = [];
      if (fs.existsSync(ARCHIVE_INDEX_PATH)) {
        try { index = JSON.parse(fs.readFileSync(ARCHIVE_INDEX_PATH, "utf8")); } catch (e) { index = []; }
      }
      if (!index.includes(old.weekKey)) index.unshift(old.weekKey);
      fs.writeFileSync(ARCHIVE_INDEX_PATH, JSON.stringify(index, null, 2));
    }
  }

  fs.writeFileSync(CURRENT_PATH, JSON.stringify(newData, null, 2));
  console.log(`Listo: ${weekKey} — ${picks.length} picks (${picks.filter(p=>p.type==="plataforma").length} plataforma, ${picks.filter(p=>p.type==="cine").length} cine)`);
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function weekLabelFor(d) {
  const start = new Date(d);
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = (dt) => dt.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
  return `${fmt(start)}–${fmt(end)}`;
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  tmdb, loadGenres, getNowPlayingCine, getProvidersAR, buildPick,
  normTitle, pickTmdbId, loadWeeks, loadUsed, isUsed,
  thursdayAnchor, isoWeekKey, weekLabelFor, main,
};
