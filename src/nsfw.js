// Verificador de imagens (carregado só quando precisa). Roda tudo no aparelho.
import "@tensorflow/tfjs";
import { load } from "nsfwjs/core";
import { MobileNetV2Model } from "nsfwjs/models/mobilenet_v2";

let modelo = null;
async function carregar() {
  if (!modelo) modelo = load("MobileNetV2", { modelDefinitions: [MobileNetV2Model] });
  return modelo;
}
// Devolve { Porn, Hentai, Sexy, Drawing, Neutral } (0..1)
async function classificar(img) {
  const m = await carregar();
  const r = await m.classify(img, 5);
  const o = {};
  r.forEach(p => { o[p.className] = p.probability; });
  return o;
}
window.EstanteNSFW = { carregar, classificar };
