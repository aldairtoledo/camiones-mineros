// Conversion de pixeles a metros: copia en JavaScript de georreferencia.py (mismas formulas).
// Pixeles = resolucion ORIGINAL del video (origen arriba a la izquierda, y hacia abajo).

function resolver3(a, b) {
  // Resuelve un sistema 3x3 a·x = b (eliminacion de Gauss con pivoteo).
  const m = a.map((fila, i) => [...fila, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let f = c + 1; f < 3; f++) if (Math.abs(m[f][c]) > Math.abs(m[p][c])) p = f;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) throw new Error("Los puntos no pueden estar en línea recta.");
    for (let f = 0; f < 3; f++) {
      if (f === c) continue;
      const k = m[f][c] / m[c][c];
      for (let j = c; j < 4; j++) m[f][j] -= k * m[c][j];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

export class Georreferencia {
  constructor(puntos, info = {}) {
    this.info = { ...(info || {}) };
    this.puntos = puntos.map((p) => p.map(Number));
    if (this.puntos.length < 2) throw new Error("Se necesitan al menos 2 puntos de control.");
    this.origen = [this.puntos[0][2], this.puntos[0][3]];
    const px = this.puntos.map((p) => [p[0], p[1]]);
    const en = this.puntos.map((p) => [p[2] - this.origen[0], p[3] - this.origen[1]]);
    const n = this.puntos.length;
    if (n === 2) {
      // Similitud: E + iN = a * (x - i y) + b
      const w = px.map(([x, y]) => [x, -y]);
      const dw = [w[1][0] - w[0][0], w[1][1] - w[0][1]];
      const dz = [en[1][0] - en[0][0], en[1][1] - en[0][1]];
      const den = dw[0] * dw[0] + dw[1] * dw[1];
      if (den < 1e-18) throw new Error("Los 2 puntos están en el mismo lugar de la imagen.");
      const ar = (dz[0] * dw[0] + dz[1] * dw[1]) / den;
      const ai = (dz[1] * dw[0] - dz[0] * dw[1]) / den;
      const br = en[0][0] - (ar * w[0][0] - ai * w[0][1]);
      const bi = en[0][1] - (ar * w[0][1] + ai * w[0][0]);
      this.m = [[ar, ai, br], [ai, -ar, bi]];
      this.metodo = "Similitud (2 puntos)";
    } else {
      // Afin (3 puntos exacta, 4 o mas por minimos cuadrados): ecuaciones normales.
      const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const ate = [0, 0, 0], atn = [0, 0, 0];
      px.forEach(([x, y], i) => {
        const v = [x, y, 1];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) ata[r][c] += v[r] * v[c];
          ate[r] += v[r] * en[i][0];
          atn[r] += v[r] * en[i][1];
        }
      });
      this.m = [resolver3(ata, ate), resolver3(ata, atn)];
      this.metodo = n === 3 ? "Afín (3 puntos)" : `Afín por mínimos cuadrados (${n} puntos)`;
    }
    const det = this.m[0][0] * this.m[1][1] - this.m[0][1] * this.m[1][0];
    this.inv = [[this.m[1][1] / det, -this.m[0][1] / det], [-this.m[1][0] / det, this.m[0][0] / det]];
    this.residuos = this.puntos.map((p) => {
      const [e, nn] = this.aCoordenadas(p[0], p[1]);
      return Math.hypot(e - p[2], nn - p[3]);
    });
    this.errorM = Math.sqrt(this.residuos.reduce((s, r) => s + r * r, 0) / n);
    this.escalaMPx = this._escalaMedia();
  }

  static desdeDict(d) { return d ? new Georreferencia(d.puntos, d.info) : null; }

  aCoordenadas(x, y) {
    const [a, b] = this.m;
    return [a[0] * x + a[1] * y + a[2] + this.origen[0], b[0] * x + b[1] * y + b[2] + this.origen[1]];
  }

  aPixel(este, norte) {
    const de = este - this.origen[0] - this.m[0][2];
    const dn = norte - this.origen[1] - this.m[1][2];
    return [this.inv[0][0] * de + this.inv[0][1] * dn, this.inv[1][0] * de + this.inv[1][1] * dn];
  }

  _escalaMedia() {
    const cx = this.puntos.reduce((s, p) => s + p[0], 0) / this.puntos.length;
    const cy = this.puntos.reduce((s, p) => s + p[1], 0) / this.puntos.length;
    const e0 = this.aCoordenadas(cx, cy), e1 = this.aCoordenadas(cx + 10, cy), e2 = this.aCoordenadas(cx, cy + 10);
    return (Math.hypot(e1[0] - e0[0], e1[1] - e0[1]) + Math.hypot(e2[0] - e0[0], e2[1] - e0[1])) / 20;
  }

  esPlano() { return this.info.modo === "plano"; }
  origenPlano() { return [this.info.origen_e || 0, this.info.origen_n || 0]; }
  aPlano(x, y) {
    const [e, n] = this.aCoordenadas(x, y);
    const [e0, n0] = this.origenPlano();
    return [e - e0, n - n0];
  }
  errorMedible() { return this.puntos.length >= 4; }
  aDict() { return { puntos: this.puntos, info: this.info }; }

  /** Filas para la hoja Parametros del Excel (georreferencia.descripcion). */
  descripcion() {
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    if (this.esPlano()) {
      const i = this.info, [e0, n0] = this.origenPlano();
      const filas = [["Metodo", "Plano local: origen (0; 0) en la esquina inferior izquierda, X a la derecha, Y hacia arriba"],
                     ["Escala calibrada con", i.fuente || "-"],
                     ["Escala (m por pixel)", r4(this.escalaMPx)],
                     ["Largo del camion usado (m)", i.largo_m ?? "-"],
                     ["Ancho del camion usado (m)", i.ancho_m || "-"],
                     ["Largo medido en el video (px)", i.largo_px ?? "-"],
                     ["Camiones medidos", i.camiones_medidos ?? "-"],
                     ["Precision aproximada de posicion (m)", i.precision_m ?? "-"],
                     ["Coordenadas del origen (E, N)", `${e0.toFixed(2)}, ${n0.toFixed(2)}`]];
      (i.distancias || []).forEach(([x1, y1, x2, y2, m], k) => filas.push([`Distancia conocida ${k + 1}`,
        `(${x1.toFixed(0)}, ${y1.toFixed(0)}) a (${x2.toFixed(0)}, ${y2.toFixed(0)}) px = ${m.toFixed(2)} m`]));
      return filas;
    }
    const filas = [["Metodo", this.metodo],
                   ["Error medio de los puntos de control (m)", this.errorMedible() ? Math.round(this.errorM * 1000) / 1000
                     : "no se puede medir con 2 o 3 puntos (usa 4 o mas)"],
                   ["Escala aproximada (m por pixel)", r4(this.escalaMPx)]];
    this.puntos.forEach(([x, y, e, n], k) => filas.push([`Punto de control ${k + 1}`,
      `pixel (${x.toFixed(0)}, ${y.toFixed(0)})  ->  E ${e.toFixed(2)}  N ${n.toFixed(2)}`]));
    return filas;
  }

  /** Misma georreferencia (mismos puntos y origen)? */
  igualA(otra) {
    return !!otra && JSON.stringify(this.puntos) === JSON.stringify(otra.puntos) &&
      this.esPlano() === otra.esPlano();
  }
}

/** Georreferencia de ejemplo (georreferencia.ejemplo): esquina inferior izquierda en E 350 000, N 8 460 000. */
export function ejemplo(ancho, alto, anchoM = 400, este = 350000, norte = 8460000) {
  const k = anchoM / ancho;
  return new Georreferencia([[0, alto, este, norte], [ancho, alto, este + anchoM, norte],
                             [0, 0, este, norte + alto * k], [ancho, 0, este + anchoM, norte + alto * k]], { modo: "puntos" });
}

export function pasoGrilla(anchoM, lineas = 8) {
  const bruto = Math.max(anchoM / Math.max(lineas, 1), 1e-6);
  const base = 10 ** Math.floor(Math.log10(bruto));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= bruto) return m * base;
  return 10 * base;
}
