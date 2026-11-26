// Limpeza diária do fórum: apaga mensagens (salas públicas e privadas) e avisos (menções) com mais de 7 dias.
// Roda no GitHub junto com o ranking, todo dia de madrugada.
const admin = require("firebase-admin");
module.exports = async function limpar(db) {
  const limite = Date.now() - 7 * 86400e3;
  let n = 0;
  for (const sala of ["geral", "rec", "spo"]) {
    const velhas = await db.collection("forum").doc(sala).collection("msgs").where("criadoEm", "<", limite).get();
    let lote = db.batch(), k = 0;
    for (const d of velhas.docs) { lote.delete(d.ref); n++; if (++k % 400 === 0) { await lote.commit(); lote = db.batch(); } }
    if (k % 400) await lote.commit();
  }
  // salas privadas: mesma regra de 7 dias
  const salas = await db.collection("salas").get();
  for (const sd of salas.docs) {
    const velhas = await sd.ref.collection("msgs").where("criadoEm", "<", limite).get();
    let lote = db.batch(), k = 0;
    for (const d of velhas.docs) { lote.delete(d.ref); n++; if (++k % 400 === 0) { await lote.commit(); lote = db.batch(); } }
    if (k % 400) await lote.commit();
  }
  const avisos = await db.collectionGroup("avisos").get();
  let lote = db.batch(), k = 0, a = 0;
  for (const d of avisos.docs) if ((d.data().em || 0) < limite) { lote.delete(d.ref); a++; if (++k % 400 === 0) { await lote.commit(); lote = db.batch(); } }
  if (k % 400) await lote.commit();
  console.log(`Fórum: ${n} mensagens e ${a} avisos com mais de 7 dias apagados.`);
};
