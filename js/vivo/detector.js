// Detector YOLO OBB en el navegador (misma logica que Ultralytics: letterbox 640, conf 0.25, NMS rotado probiou 0.7).
// La imagen se estira a W x H (800 x 600, como hace motor.py) y luego se encuadra en 640 x 640.
export class Detector {
  constructor(ort, sesion) {
    this.ort = ort; this.s = sesion;
    this.lienzo = document.createElement("canvas"); this.lienzo.width = 640; this.lienzo.height = 640;
    this.c = this.lienzo.getContext("2d", { willReadFrequently: true });
    this.datos = new Float32Array(3 * 640 * 640);
  }
  static async crear(ort, url, proveedores) {
    const s = await ort.InferenceSession.create(url, { executionProviders: proveedores, graphOptimizationLevel: "all" });
    return new Detector(ort, s);
  }
  /** recorte: [sx, sy, sw, sh] de la fuente que se analiza (por defecto, toda). */
  async detectar(fuente, W, H, conf = 0.25, iou = 0.7, recorte = null) {
    const t0 = performance.now();
    const r = Math.min(640 / W, 640 / H), nw = Math.round(W * r), nh = Math.round(H * r);
    const l = Math.floor((640 - nw) / 2), t = Math.floor((640 - nh) / 2);
    const c = this.c;
    c.fillStyle = "rgb(114,114,114)"; c.fillRect(0, 0, 640, 640);
    if (recorte) c.drawImage(fuente, recorte[0], recorte[1], recorte[2], recorte[3], l, t, nw, nh);
    else c.drawImage(fuente, l, t, nw, nh);
    const px = c.getImageData(0, 0, 640, 640).data, d = this.datos, N = 640 * 640;
    for (let i = 0, j = 0; i < N; i++, j += 4) { d[i] = px[j] / 255; d[i + N] = px[j + 1] / 255; d[i + 2 * N] = px[j + 2] / 255; }
    const ent = new this.ort.Tensor("float32", d, [1, 3, 640, 640]);
    const t1 = performance.now();
    const sal = (await this.s.run({ images: ent })).output0;
    const t2 = performance.now();
    const o = sal.data, M = sal.dims[2];
    let cand = [];
    for (let k = 0; k < M; k++) {
      const s = o[4 * M + k];
      if (s > conf) cand.push([o[k], o[M + k], o[2 * M + k], o[3 * M + k], o[5 * M + k], s]);
    }
    cand.sort((a, b) => b[5] - a[5]);
    const quedan = [];
    for (let i = 0; i < cand.length; i++) {
      let ok = true;
      for (let j = 0; j < i; j++) if (probiou(cand[j], cand[i]) >= iou) { ok = false; break; }
      if (ok) quedan.push(cand[i]);
    }
    this.tiempos = { preparar: t1 - t0, modelo: t2 - t1, final: performance.now() - t2 };
    return quedan.map(([cx, cy, w, h, a, s]) => [(cx - l) / r, (cy - t) / r, w / r, h / r, a, s]);
  }
}
function cov(b) {
  const a = b[2] * b[2] / 12, bb = b[3] * b[3] / 12, co = Math.cos(b[4]), si = Math.sin(b[4]);
  return [a * co * co + bb * si * si, a * si * si + bb * co * co, (a - bb) * co * si];
}
function probiou(b1, b2, eps = 1e-7) {
  const [a1, b_1, c1] = cov(b1), [a2, b_2, c2] = cov(b2);
  const A = a1 + a2, B = b_1 + b_2, C = c1 + c2, den = A * B - C * C + eps;
  const dx = b1[0] - b2[0], dy = b1[1] - b2[1];
  const t1 = (A * dy * dy + B * dx * dx) / den * 0.25;
  const t2 = (C * (b2[0] - b1[0]) * dy) / den * 0.5;
  const t3 = Math.log((A * B - C * C) / (4 * Math.sqrt(Math.max(a1 * b_1 - c1 * c1, 0) * Math.max(a2 * b_2 - c2 * c2, 0)) + eps) + eps) * 0.5;
  const bd = Math.min(Math.max(t1 + t2 + t3, eps), 100);
  return 1 - Math.sqrt(1 - Math.exp(-bd) + eps);
}
