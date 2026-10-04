// Manda el aviso de los jueves ("¿Qué vemos? · <semana>") a todos los dispositivos
// anotados en Firestore pushTokens, vía Firebase Cloud Messaging HTTP v1.
//
// Node 20+, sin dependencias npm (crypto + fetch nativos).
// Variable de entorno requerida: FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).
//
//   node scripts/notify.js                 manda de verdad
//   node scripts/notify.js --validate-only FCM valida cada envío sin entregarlo (no borra nada)
//   node scripts/notify.js --dry-run       solo lista los tokens y arma el mensaje
//
// Los tokens que FCM da por muertos (UNREGISTERED / 404) se borran de Firestore.
// En los logs los tokens salen recortados.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROJECT_ID = "que-vemos-74ff3";
const SITE_URL = "https://capitan-alej.github.io/que-vemos/";
const ICON_URL = SITE_URL + "icons/icon-192.png";
const CURRENT_PATH = path.join(__dirname, "..", "data", "current.json");
const SCOPES = [
  "https://www.googleapis.com/auth/firebase.messaging",
  "https://www.googleapis.com/auth/datastore"
];
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FCM_SEND = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const mask = (t) => (t ? `${t.slice(0, 8)}…${t.slice(-4)}` : "?");

// --- OAuth2 con la cuenta de servicio (JWT RS256 → access token) --------------

function signJwt(sa, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPES.join(" "),
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
  return `${unsigned}.${b64url(signature)}`;
}

async function getAccessToken(sa) {
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signJwt(sa)
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`OAuth ${res.status}: ${j.error || ""} ${j.error_description || ""}`);
  return j.access_token;
}

// --- Firestore REST -------------------------------------------------------------

// Devuelve [{name, token, uid, who}] sin tokens repetidos.
function parseTokenDocs(documents) {
  const seen = new Set();
  const out = [];
  for (const d of documents || []) {
    const f = d.fields || {};
    const token = f.token && f.token.stringValue;
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push({
      name: d.name,
      token,
      uid: (f.uid && f.uid.stringValue) || "",
      who: (f.name && f.name.stringValue) || "?"
    });
  }
  return out;
}

async function listTokens(accessToken) {
  const docs = [];
  let pageToken = "";
  do {
    const url = new URL(`${FIRESTORE}/pushTokens`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Firestore list ${res.status}: ${(j.error && j.error.message) || ""}`);
    docs.push(...(j.documents || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return parseTokenDocs(docs);
}

async function deleteDoc(accessToken, docName) {
  const res = await fetch(`https://firestore.googleapis.com/v1/${docName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Firestore delete ${res.status}`);
}

// --- Mensaje --------------------------------------------------------------------

function shortVenue(p) {
  if (p.type === "cine") return "cine";
  return String(p.venue || "plataforma").replace(/^Amazon\s+/i, "");
}

function buildNotification(current) {
  const picks = (current && current.picks) || [];
  const title = `¿Qué vemos? · ${(current && (current.weekLabel || current.weekKey)) || "esta semana"}`;
  const body = picks.length
    ? picks.map((p) => `${p.title} (${shortVenue(p)})`).join(" · ")
    : "Ya está la selección de la semana.";
  return { title, body, icon: ICON_URL };
}

function buildMessage(token, notification) {
  return {
    token,
    webpush: {
      notification,
      fcm_options: { link: SITE_URL }
    }
  };
}

// Clasifica la respuesta de FCM: "ok" | "dead" (token muerto, borrar) | "error".
function classifySend(status, json) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "dead";
  const details = (json && json.error && json.error.details) || [];
  if (details.some((d) => d && d.errorCode === "UNREGISTERED")) return "dead";
  if (json && json.error && json.error.status === "NOT_FOUND") return "dead";
  return "error";
}

async function send(accessToken, message, validateOnly) {
  const res = await fetch(FCM_SEND, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ validate_only: validateOnly, message })
  });
  const j = await res.json().catch(() => ({}));
  return { kind: classifySend(res.status, j), status: res.status, error: j.error && j.error.message };
}

// --- main -----------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const validateOnly = argv.includes("--validate-only");
  const mode = dryRun ? "dry-run" : validateOnly ? "validate-only" : "envío real";

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Falta FIREBASE_SERVICE_ACCOUNT en el entorno.");
  const sa = JSON.parse(raw);

  const current = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
  const notification = buildNotification(current);
  console.log(`Modo: ${mode}`);
  console.log(`Título: ${notification.title}`);
  console.log(`Cuerpo: ${notification.body}`);

  const accessToken = await getAccessToken(sa);
  const tokens = await listTokens(accessToken);
  console.log(`Dispositivos anotados: ${tokens.length}`);
  for (const t of tokens) console.log(`  - ${t.who} ${mask(t.token)}`);
  if (!tokens.length) {
    console.log("No hay a quién avisar. Listo.");
    return 0;
  }
  if (dryRun) {
    console.log("Mensaje (ejemplo):", JSON.stringify(buildMessage(mask(tokens[0].token), notification), null, 2));
    return 0;
  }

  let ok = 0, dead = 0, failed = 0;
  for (const t of tokens) {
    const r = await send(accessToken, buildMessage(t.token, notification), validateOnly);
    if (r.kind === "ok") {
      ok++;
      console.log(`  ✓ ${t.who} ${mask(t.token)}`);
    } else if (r.kind === "dead") {
      dead++;
      if (validateOnly) {
        console.log(`  ✗ ${t.who} ${mask(t.token)} token muerto (${r.status}) — se borraría en un envío real`);
      } else {
        try {
          await deleteDoc(accessToken, t.name);
          console.log(`  ✗ ${t.who} ${mask(t.token)} token muerto (${r.status}) — borrado`);
        } catch (e) {
          console.log(`  ✗ ${t.who} ${mask(t.token)} token muerto, no se pudo borrar: ${e.message}`);
        }
      }
    } else {
      failed++;
      console.log(`  ! ${t.who} ${mask(t.token)} error ${r.status}: ${r.error || ""}`);
    }
  }
  console.log(`Resultado: ${ok} ok, ${dead} muertos, ${failed} con error.`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => { console.error(e.message || e); process.exit(1); }
  );
}

module.exports = { signJwt, parseTokenDocs, buildNotification, buildMessage, classifySend, mask, main };
