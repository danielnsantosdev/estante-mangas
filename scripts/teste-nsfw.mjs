import * as tf from "@tensorflow/tfjs";
import { load } from "nsfwjs/core";
import { MobileNetV2Model } from "nsfwjs/models/mobilenet_v2";
await tf.setBackend("cpu");
const t0 = Date.now();
const m = await load("MobileNetV2", { modelDefinitions: [MobileNetV2Model] });
console.log("carregou em", Date.now() - t0, "ms");
const img = tf.fill([224, 224, 3], 200, "int32");
console.log(JSON.stringify(await m.classify(img, 5)));
