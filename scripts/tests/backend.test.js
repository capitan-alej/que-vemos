// Pruebas de update-picks.js y complete-suggestions.js con fetch mockeado (sin red, sin claves).
// Correr: node --test scripts/tests/
//
// Cada prueba copia los scripts a una carpeta temporal con su propio data/ de juguete,
// así nunca se tocan los datos reales del sitio.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SCRIPTS = path.join(__dirname, "..");
process.env.TMDB_API_KEY = "tmdb-falsa";
process.env.OMDB_API_KEY = "omdb-falsa";
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  client_email: "bot@test", private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

// --- utilidades ---------------------------------------------------------------

function sandbox({ current, archive = {}, sugeridas }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quevemos-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "data", "archive"), { recursive: true });
  for (const f of ["update-picks.js", "complete-suggestions.js", "notify.js"]) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, "scripts", f));
  }
  const w = (rel, obj) => fs.writeFileSync(path.join(root, "data", rel), JSON.stringify(obj, null, 2));
  if (current) w("current.json", current);
  w("archive-index.json", Object.keys(archive));
  for (const [k, v] of Object.entries(archive)) w(`archive/${k}.json`, v);
  if (sugeridas) w("sugeridas.json", sugeridas);
  return {
    root,
    req: (name) => require(path.join(root, "scripts", name)),
    read: (rel) => JSON.parse(fs.readFileSync(path.join(root, "data", rel), "utf8")),
    exists: (rel) => fs.existsSync(path.join(root, "data", rel)),
    mtime: (rel) => fs.statSync(path.join(root, "data", rel)).mtimeMs,
  };
}

const tmdbUrl = (id) => [{ label: "TMDB", url: `https://www.themoviedb.org/movie/${id}` }];
const week = (weekKey, picks) => ({ weekKey, weekLabel: "x", generatedAt: "x", picks });
const movie = (id, title, original_title = title) => ({ id, title, original_title, genre_ids: [18] });

// Mundo TMDB/Firestore falso. movies: {id: {title, original_title, flatrate?}}
function mockFetch({ movies = {}, nowPlaying = [], trending = [], popular1 = [], popular2 = [], search = {}, docs = [] }) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  global.fetch = async (input, opts = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "tok" });
    if (url.hostname === "firestore.googleapis.com") return json({ documents: docs });
    if (url.hostname === "www.omdbapi.com") return json({ Response: "False" });
    const p = url.pathname.replace("/3", "");
    const page = url.searchParams.get("page");
    if (p === "/genre/movie/list") return json({ genres: [{ id: 18, name: "Drama" }] });
    if (p === "/movie/now_playing") return json({ results: nowPlaying });
    if (p === "/trending/movie/week") return json({ results: trending });
    if (p === "/movie/popular") return json({ results: page === "2" ? popular2 : popular1 });
    if (p === "/search/movie") return json({ results: search[url.searchParams.get("query")] || [] });
    let m = p.match(/^\/movie\/(\d+)\/watch\/providers$/);
    if (m) {
      const f = (movies[m[1]] || {}).flatrate;
      return json({ results: f ? { AR: { flatrate: f.map((n) => ({ provider_name: n })) } } : {} });
    }
    m = p.match(/^\/movie\/(\d+)$/);
    if (m && movies[m[1]]) {
      const mv = movies[m[1]];
      return json({
        id: Number(m[1]), title: mv.title, original_title: mv.original_title || mv.title,
        vote_average: mv.vote || 7, vote_count: 1000, runtime: 100, genres: [{ id: 18 }],
        poster_path: "/p.jpg", external_ids: { imdb_id: null },
        credits: { crew: [{ job: "Director", name: "Dire" }] },
      });
    }
    return json({}, 404);
  };
  return calls;
}

// --- 1. semana anclada al jueves ----------------------------------------------------

test("ancla del jueves: lunes 5/10 → W40 '1 oct–7 oct'; jueves 8/10 9:00 ART → W41", () => {
  const { thursdayAnchor, isoWeekKey, weekLabelFor } = sandbox({}).req("update-picks.js");
  const wk = (iso) => { const a = thursdayAnchor(new Date(iso)); return [isoWeekKey(a), weekLabelFor(a)]; };
  assert.deepEqual(wk("2026-10-05T12:00:00-03:00"), ["2026-W40", "1 oct–7 oct"]);
  assert.deepEqual(wk("2026-10-08T09:00:00-03:00"), ["2026-W41", "8 oct–14 oct"]);
  assert.deepEqual(wk("2026-10-01T00:00:00-03:00"), ["2026-W40", "1 oct–7 oct"]); // jueves 0:00 ART
  assert.deepEqual(wk("2026-10-08T02:30:00Z"), ["2026-W40", "1 oct–7 oct"]);     // miércoles 23:30 ART
});

// --- 2. no repetir títulos ---------------------------------------------------------

// 30 pelis de plataforma ya usadas (ids 101-130) llenan trending: obliga a mirar más allá de las primeras 25.
function bigWorld() {
  const movies = {};
  const usedOld = [];
  for (let i = 101; i <= 130; i++) { movies[i] = { title: `Vieja ${i}`, flatrate: ["Netflix"] }; usedOld.push(i); }
  Object.assign(movies, {
    2: { title: "De la semana actual", flatrate: ["Disney Plus"], vote: 9 },
    5: { title: "El Señor de los Anillos", original_title: "The Lord of the Rings", flatrate: ["Max"], vote: 9.5 },
    6: { title: "Sugerida antes", flatrate: ["Max"], vote: 9.4 },
    7: { title: "Nueva A", flatrate: ["Netflix"], vote: 6 },
    8: { title: "Nueva B", flatrate: ["Max"], vote: 5 },
    9: { title: "Cine nuevo", vote: 8 },
  });
  return {
    movies,
    nowPlaying: [movie(105, "Vieja 105"), movie(9, "Cine nuevo")],
    trending: usedOld.map((i) => movie(i, `Vieja ${i}`)),
    popular1: [movie(2, "De la semana actual"), movie(5, "El senor de los anillos")],
    popular2: [movie(6, "Sugerida antes"), movie(7, "Nueva A"), movie(8, "Nueva B")],
  };
}
function historyFixture() {
  return {
    archive: {
      "2026-W39": week("2026-W39", [
        ...Array.from({ length: 30 }, (_, k) => ({ title: `Vieja ${101 + k}`, sources: tmdbUrl(101 + k) })),
        { title: "El señor de los anillos!", original: "", sources: [{ label: "LB", url: "https://letterboxd.com/x" }] },
      ]),
    },
    current: week("2026-W40", [{ title: "De la semana actual", sources: tmdbUrl(2), tmdbId: 2 }]),
    sugeridas: { updatedAt: "x", items: [{ sugId: "s", status: "ok", title: "Sugerida antes", tmdbId: 6 }] },
  };
}

test("regenerar la misma semana: excluye historial por tmdbId y por título, no excluye la propia semana", async () => {
  const sb = sandbox(historyFixture());
  mockFetch(bigWorld());
  await sb.req("update-picks.js").main(new Date("2026-10-05T15:00:00Z")); // lunes
  const cur = sb.read("current.json");
  assert.equal(cur.weekKey, "2026-W40");
  assert.equal(cur.weekLabel, "1 oct–7 oct");
  const ids = cur.picks.map((p) => p.tmdbId);
  assert.ok(ids.includes(2), "la semana que se regenera no se excluye a sí misma");
  assert.ok(!ids.includes(5), "excluida por título normalizado");
  assert.ok(!ids.includes(6), "excluida por estar en sugeridas.json");
  assert.ok(!ids.some((i) => i > 100), "excluidas por tmdbId del archivo");
  assert.ok(ids.every((i) => typeof i === "number"));
  assert.ok(cur.picks.filter((p) => p.type === "plataforma").length >= 2);
  assert.ok(cur.picks.length >= 3 && cur.picks.length <= 4);
  assert.deepEqual(sb.read("archive-index.json"), ["2026-W39"], "no archiva la misma semana");
});

test("semana nueva (jueves): archiva la vigente y también excluye sus picks", async () => {
  const sb = sandbox(historyFixture());
  mockFetch(bigWorld());
  await sb.req("update-picks.js").main(new Date("2026-10-08T12:00:00Z")); // jueves 9:00 ART
  const cur = sb.read("current.json");
  assert.equal(cur.weekKey, "2026-W41");
  assert.equal(cur.weekLabel, "8 oct–14 oct");
  const ids = cur.picks.map((p) => p.tmdbId);
  assert.deepEqual(ids.sort(), [7, 8, 9]);
  assert.deepEqual(sb.read("archive-index.json"), ["2026-W40", "2026-W39"]);
  assert.equal(sb.read("archive/2026-W40.json").picks[0].tmdbId, 2);
});

// --- 3. complete-suggestions ---------------------------------------------------------

const doc = (sugId, title, name, addedAt) => ({
  name: `projects/que-vemos-74ff3/databases/(default)/documents/sugerencias/${sugId}`,
  fields: { title: { stringValue: title }, uid: { stringValue: "u" }, name: { stringValue: name }, addedAt: { timestampValue: addedAt } },
});
const sugWorld = (docs) => ({
  docs,
  movies: {
    1: { title: "Toy Story 5", flatrate: ["Disney Plus"] },
    10: { title: "Nueva", original_title: "New One", flatrate: ["Netflix"] },
    11: { title: "En cines" },
    12: { title: "Rara" },
  },
  nowPlaying: [movie(11, "En cines")],
  search: {
    "toy story": [movie(1, "Toy Story 5")],
    "nueva": [movie(10, "Nueva", "New One")],
    "la nueva otra vez": [movie(10, "Nueva", "New One")],
    "en cines": [movie(11, "En cines")],
    "rara": [movie(12, "Rara")],
  },
});
const allDocs = [
  doc("toy-story", "toy story", "Alej", "2026-10-05T10:00:00Z"),
  doc("nada", "asdfgh", "Alej", "2026-10-05T10:01:00Z"),
  doc("nueva", "nueva", "Mamá", "2026-10-05T10:02:00Z"),
  doc("en-cines", "en cines", "Alej", "2026-10-05T10:03:00Z"),
  doc("rara", "rara", "Alej", "2026-10-05T10:04:00Z"),
  doc("la-nueva-otra-vez", "la nueva otra vez", "Papá", "2026-10-05T10:05:00Z"),
];

test("complete-suggestions: ok / no_encontrado / duplicado, luego sin cambios, luego borrada", async () => {
  const sb = sandbox({
    archive: { "2026-W39": week("2026-W39", [{ title: "Toy Story 5", sources: tmdbUrl(1) }]) },
    current: week("2026-W40", []),
  });
  const cs = sb.req("complete-suggestions.js");

  // 1ª corrida: todo nuevo
  mockFetch(sugWorld(allDocs));
  await cs.main();
  const by = Object.fromEntries(sb.read("sugeridas.json").items.map((it) => [it.sugId, it]));
  assert.equal(by["toy-story"].status, "duplicado");
  assert.equal(by["toy-story"].duplicateOf, "Semana 2026-W39");
  assert.equal(by["nada"].status, "no_encontrado");
  assert.equal(by["nada"].query, "asdfgh");
  assert.equal(by["nueva"].status, "ok");
  assert.equal(by["nueva"].type, "plataforma");
  assert.equal(by["nueva"].venue, "Netflix");
  assert.equal(by["nueva"].tmdbId, 10);
  assert.equal(by["nueva"].suggestedBy, "Mamá");
  assert.equal(by["nueva"].suggestedAt, "2026-10-05T10:02:00Z");
  assert.equal(by["nueva"].original, "New One");
  assert.ok(!("_score" in by["nueva"]));
  assert.equal(by["en-cines"].type, "cine");
  assert.equal(by["en-cines"].venue, "Cines (AR)");
  assert.equal(by["rara"].type, "otra");
  assert.equal(by["rara"].venue, "Sin plataforma en AR");
  assert.equal(by["la-nueva-otra-vez"].status, "duplicado");
  assert.equal(by["la-nueva-otra-vez"].duplicateOf, "sugerida por Mamá");

  // 2ª corrida: nada nuevo ni borrado → no reescribe ni consulta TMDB
  const before = fs.readFileSync(path.join(sb.root, "data", "sugeridas.json"), "utf8");
  const t0 = sb.mtime("sugeridas.json");
  const calls = mockFetch(sugWorld(allDocs));
  await new Promise((r) => setTimeout(r, 20));
  await cs.main();
  assert.equal(sb.mtime("sugeridas.json"), t0);
  assert.equal(fs.readFileSync(path.join(sb.root, "data", "sugeridas.json"), "utf8"), before);
  assert.ok(!calls.some((c) => c.startsWith("/3/")), "no llama a TMDB");

  // 3ª corrida: el dueño borró "rara"
  mockFetch(sugWorld(allDocs.filter((d) => !d.name.endsWith("/rara"))));
  await cs.main();
  const ids = sb.read("sugeridas.json").items.map((it) => it.sugId);
  assert.equal(ids.length, 5);
  assert.ok(!ids.includes("rara"));
});

test("complete-suggestions: sin sugerencias y sin archivo → no crea sugeridas.json", async () => {
  const sb = sandbox({ current: week("2026-W40", []) });
  mockFetch(sugWorld([]));
  await sb.req("complete-suggestions.js").main();
  assert.equal(sb.exists("sugeridas.json"), false);
});

test("normTitle: minúsculas, sin acentos, sin puntuación", async () => {
  const { normTitle } = sandbox({}).req("update-picks.js");
  assert.equal(normTitle("¡El Señor, de los Anillos!"), "el senor de los anillos");
});
