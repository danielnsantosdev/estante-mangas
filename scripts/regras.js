// Publica o arquivo firestore.rules no Firebase (regras de segurança), sem precisar copiar e colar no site.
// Roda sozinho quando o firestore.rules muda no GitHub, ou manualmente na aba Actions → "Publicar regras".
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

let sa;
try { sa = JSON.parse(String(process.env.FIREBASE_SA || "").replace(/^﻿/, "").trim()); }
catch (e) { console.error("A chave FIREBASE_SA não pôde ser lida."); process.exit(1); }
sa.private_key = String(sa.private_key || "").replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(sa) });

(async () => {
  const fonte = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
  const r = await admin.securityRules().releaseFirestoreRulesetFromSource(fonte);
  console.log("Regras publicadas no Firebase: " + r.name);
  process.exit(0);
})().catch(e => { console.error("Não consegui publicar as regras: " + (e.message || e)); process.exit(1); });
