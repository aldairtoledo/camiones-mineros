// Seguimiento de camiones en el navegador: copia en JavaScript de lo que hace la app de escritorio.
//   - ByteTrack de Ultralytics 8.4.66 (trackers/byte_tracker.py, utils/kalman_filter.py, utils/matching.py)
//     con los parametros de bytetrack_minas.yaml.
//   - FleetIdentityManager de deteccion_camiones.py (numeros 1, 2, 3..., salidas por el borde,
//     camiones anclados en la cola, cajas fusionadas, proteccion de la cola).
// Mismas formulas y el mismo orden de operaciones, para que los numeros de los camiones salgan
// iguales que en Python (validado cuadro por cuadro con las mismas detecciones).

// ------------------------------------------------------------------ utilidades
/** round() de Python: los .5 van al par mas cercano. */
export function redondear(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
const entero = Math.trunc;                                   // int() de Python

/** Asignacion de costo minimo (Hungaro, potenciales) para una matriz n x m con n <= m. */
function hungaroFilas(c, n, m) {
  const INF = Infinity, u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), camino = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF), usado = new Uint8Array(m + 1);
    do {
      usado[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (usado[j]) continue;
        const cur = c[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; camino[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (usado[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = camino[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const fila = new Int32Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) fila[p[j] - 1] = j - 1;
  return fila;                                               // fila[i] = columna asignada
}

/** scipy.optimize.linear_sum_assignment: devuelve [filas, columnas] (min(n, m) parejas). */
export function asignacionLineal(c) {
  const n = c.length, m = n ? c[0].length : 0;
  if (!n || !m) return [[], []];
  if (n <= m) {
    const f = hungaroFilas(c, n, m);
    return [[...f.keys()], [...f]];
  }
  const t = Array.from({ length: m }, (_, j) => c.map((fila) => fila[j]));
  const f = hungaroFilas(t, m, n);                             // f[j] = fila asignada a la columna j
  const pares = [...f].map((i, j) => [i, j]).sort((a, b) => a[0] - b[0]);
  return [pares.map((x) => x[0]), pares.map((x) => x[1])];
}

/** lap.lapjv(costo, extend_cost=True, cost_limit=limite) como lo usa matching.linear_assignment. */
function asignacionConLimite(c, limite, m) {
  const n = c.length;
  if (!n || !m) return { pares: [], sueltasA: [...Array(n).keys()], sueltasB: [...Array(m).keys()] };
  const N = n + m, e = Array.from({ length: N }, () => new Float64Array(N).fill(limite / 2));
  for (let i = n; i < N; i++) for (let j = m; j < N; j++) e[i][j] = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) e[i][j] = c[i][j];
  const f = hungaroFilas(e, N, N);
  const x = new Int32Array(n).fill(-1), y = new Int32Array(m).fill(-1);
  for (let i = 0; i < n; i++) if (f[i] < m) { x[i] = f[i]; y[f[i]] = i; }
  const pares = [];
  for (let i = 0; i < n; i++) if (x[i] >= 0) pares.push([i, x[i]]);
  return { pares, sueltasA: [...x.keys()].filter((i) => x[i] < 0), sueltasB: [...y.keys()].filter((j) => y[j] < 0) };
}

// ------------------------------------------------------------------ probiou (cajas rotadas)
function covarianza([, , w, h, r]) {
  const a = w * w / 12, b = h * h / 12, co = Math.cos(r), si = Math.sin(r);
  return [a * co * co + b * si * si, a * si * si + b * co * co, (a - b) * co * si];
}
export function probiou(b1, b2, eps = 1e-7) {
  const [a1, b_1, c1] = covarianza(b1), [a2, b_2, c2] = covarianza(b2);
  const A = a1 + a2, B = b_1 + b_2, C = c1 + c2, den = A * B - C * C + eps;
  const dx = b1[0] - b2[0], dy = b1[1] - b2[1];
  const t1 = (A * dy * dy + B * dx * dx) / den * 0.25;
  const t2 = (C * (b2[0] - b1[0]) * dy) / den * 0.5;
  const t3 = Math.log((A * B - C * C) / (4 * Math.sqrt(Math.max(a1 * b_1 - c1 * c1, 0) * Math.max(a2 * b_2 - c2 * c2, 0)) + eps) + eps) * 0.5;
  const bd = Math.min(Math.max(t1 + t2 + t3, eps), 100);
  return 1 - Math.sqrt(1 - Math.exp(-bd) + eps);
}
const distanciaIoU = (a, b) => a.map((t) => b.map((d) => 1 - probiou(t.xywha(), d.xywha())));
const fusionarPuntaje = (dist, dets) => dist.map((fila) => fila.map((v, j) => 1 - (1 - v) * dets[j].score));

/** Esquinas de una caja rotada (ops.xywhr2xyxyxyxy). */
export function esquinas([x, y, w, h, r]) {
  const co = Math.cos(r), si = Math.sin(r);
  const v1 = [w / 2 * co, w / 2 * si], v2 = [-h / 2 * si, h / 2 * co];
  return [[x + v1[0] + v2[0], y + v1[1] + v2[1]], [x + v1[0] - v2[0], y + v1[1] - v2[1]],
          [x - v1[0] - v2[0], y - v1[1] - v2[1]], [x - v1[0] + v2[0], y - v1[1] + v2[1]]];
}

// ------------------------------------------------------------------ Kalman (x, y, aspecto, alto)
const PW = 1 / 20, VW = 1 / 160;
function mult(a, b) {
  const n = a.length, m = b[0].length, k = b.length, r = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let l = 0; l < k; l++) { const v = a[i][l]; if (v) for (let j = 0; j < m; j++) r[i][j] += v * b[l][j]; }
  return r;
}
const trans = (a) => a[0].map((_, j) => a.map((f) => f[j]));
function inversa(a) {
  const n = a.length, m = a.map((f, i) => [...f, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let f = c + 1; f < n; f++) if (Math.abs(m[f][c]) > Math.abs(m[p][c])) p = f;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    if (Math.abs(d) < 1e-300) throw new Error("Matriz singular");
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let f = 0; f < n; f++) {
      if (f === c) continue;
      const k = m[f][c];
      if (k) for (let j = 0; j < 2 * n; j++) m[f][j] -= k * m[c][j];
    }
  }
  return m.map((f) => f.slice(n));
}
const F = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => (i === j || j === i + 4 ? 1 : 0)));
const H = Array.from({ length: 4 }, (_, i) => Array.from({ length: 8 }, (_, j) => (i === j ? 1 : 0)));
const diag = (v) => v.map((x, i) => v.map((_, j) => (i === j ? x * x : 0)));

const kalman = {
  iniciar(z) {
    const h = z[3];
    return { media: [...z, 0, 0, 0, 0],
             cov: diag([2 * PW * h, 2 * PW * h, 1e-2, 2 * PW * h, 10 * VW * h, 10 * VW * h, 1e-5, 10 * VW * h]) };
  },
  predecir(media, cov) {
    const h = media[3];
    const q = diag([PW * h, PW * h, 1e-2, PW * h, VW * h, VW * h, 1e-5, VW * h]);
    const m = F.map((f) => f.reduce((s, v, j) => s + v * media[j], 0));
    const c = mult(mult(F, cov), trans(F)).map((f, i) => f.map((v, j) => v + q[i][j]));
    return { media: m, cov: c };
  },
  actualizar(media, cov, z) {
    const h = media[3];
    const r = diag([PW * h, PW * h, 1e-1, PW * h]);
    const pm = media.slice(0, 4);
    const pc = mult(mult(H, cov), trans(H)).map((f, i) => f.map((v, j) => v + r[i][j]));
    const k = mult(mult(cov, trans(H)), inversa(pc));            // 8 x 4
    const inn = z.map((v, i) => v - pm[i]);
    const m = media.map((v, i) => v + k[i].reduce((s, kk, j) => s + kk * inn[j], 0));
    const kpk = mult(mult(k, pc), trans(k));
    return { media: m, cov: cov.map((f, i) => f.map((v, j) => v - kpk[i][j])) };
  },
};

// ------------------------------------------------------------------ ByteTrack
const NUEVO = 0, SEGUIDO = 1, PERDIDO = 2, ELIMINADO = 3;
const f32 = (v) => Math.fround(v);

class Pista {
  constructor(xywha, score, idx) {
    const [x, y, w, h] = xywha;
    this._tlwh = [f32(x - w / 2), f32(y - h / 2), f32(w), f32(h)];
    this.media = null; this.cov = null;
    this.activada = false; this.estado = NUEVO;
    this.score = score; this.largo = 0; this.idx = idx; this.angulo = xywha[4];
    this.id = 0; this.cuadro = 0; this.inicio = 0;
  }
  static xyah(t) { return [t[0] + t[2] / 2, t[1] + t[3] / 2, t[2] / t[3], t[3]]; }
  tlwh() {
    if (!this.media) return [...this._tlwh];
    const [x, y, a, h] = this.media, w = a * h;
    return [x - w / 2, y - h / 2, w, h];
  }
  xywha() { const [l, t, w, h] = this.tlwh(); return [l + w / 2, t + h / 2, w, h, this.angulo]; }
  activar(cuadro, rastreador) {
    this.id = ++rastreador.ultimoId;
    ({ media: this.media, cov: this.cov } = kalman.iniciar(Pista.xyah(this._tlwh)));
    this.largo = 0; this.estado = SEGUIDO;
    if (cuadro === 1) this.activada = true;
    this.cuadro = cuadro; this.inicio = cuadro;
  }
  reactivar(nueva, cuadro) {
    ({ media: this.media, cov: this.cov } = kalman.actualizar(this.media, this.cov, Pista.xyah(nueva.tlwh())));
    this.largo = 0; this.estado = SEGUIDO; this.activada = true; this.cuadro = cuadro;
    this.score = nueva.score; this.angulo = nueva.angulo; this.idx = nueva.idx;
  }
  actualizar(nueva, cuadro) {
    this.cuadro = cuadro; this.largo += 1;
    ({ media: this.media, cov: this.cov } = kalman.actualizar(this.media, this.cov, Pista.xyah(nueva.tlwh())));
    this.estado = SEGUIDO; this.activada = true;
    this.score = nueva.score; this.angulo = nueva.angulo; this.idx = nueva.idx;
  }
}

const unir = (a, b) => { const ids = new Set(a.map((t) => t.id)); return [...a, ...b.filter((t) => !ids.has(t.id))]; };
const restar = (a, b) => { const ids = new Set(b.map((t) => t.id)); return a.filter((t) => !ids.has(t.id)); };
function quitarDuplicados(a, b) {
  const d = distanciaIoU(a, b), da = new Set(), db = new Set();
  for (let p = 0; p < a.length; p++) for (let q = 0; q < b.length; q++) {
    if (d[p][q] < 0.15) {
      if (a[p].cuadro - a[p].inicio > b[q].cuadro - b[q].inicio) db.add(q); else da.add(p);
    }
  }
  return [a.filter((_, i) => !da.has(i)), b.filter((_, i) => !db.has(i))];
}

/** ByteTrack con bytetrack_minas.yaml (umbral alto 0.5, bajo 0.1, nuevo 0.5, memoria 45 cuadros, 0.85, fuse_score). */
export class ByteTrack {
  constructor(o = {}) {
    this.alto = o.alto ?? 0.5; this.bajo = o.bajo ?? 0.1; this.nuevo = o.nuevo ?? 0.5;
    this.memoria = o.memoria ?? 45; this.umbral = o.umbral ?? 0.85; this.fusionar = o.fusionar ?? true;
    this.seguidas = []; this.perdidas = []; this.eliminadas = []; this.cuadro = 0; this.ultimoId = 0;
  }
  distancias(a, b) { const d = distanciaIoU(a, b); return this.fusionar ? fusionarPuntaje(d, b) : d; }

  /** dets: [[x, y, w, h, angulo, conf], ...] ordenadas por confianza. Devuelve [[x, y, w, h, ang, id, conf, idx]]. */
  actualizar(dets) {
    this.cuadro += 1;
    const activadas = [], reencontradas = [], perdidas = [], eliminadas = [];
    const altas = [], bajas = [];
    dets.forEach((d, i) => {
      if (d[5] >= this.alto) altas.push([d, i]);
      else if (d[5] > this.bajo) bajas.push([d, i]);
    });
    // el indice "idx" es la posicion dentro de su grupo (parse_bboxes usa arange sobre results[mascara])
    let detecciones = altas.map(([d], k) => new Pista(d, d[5], k));
    const segundas = bajas.map(([d], k) => new Pista(d, d[5], k));
    const sinConfirmar = [], seguidas = [];
    for (const t of this.seguidas) (t.activada ? seguidas : sinConfirmar).push(t);
    const grupo = unir(seguidas, this.perdidas);
    for (const t of grupo) {                                   // multi_predict
      const m = [...t.media];
      if (t.estado !== SEGUIDO) m[7] = 0;
      ({ media: t.media, cov: t.cov } = kalman.predecir(m, t.cov));
    }
    const aplicar = (t, d) => {
      if (t.estado === SEGUIDO) { t.actualizar(d, this.cuadro); activadas.push(t); }
      else { t.reactivar(d, this.cuadro); reencontradas.push(t); }
    };
    // 1) primera asociacion: pistas con detecciones de alta confianza
    const r = asignacionConLimite(this.distancias(grupo, detecciones), this.umbral, detecciones.length);
    for (const [it, id] of r.pares) aplicar(grupo[it], detecciones[id]);
    const sueltasDet = r.sueltasB, sinPista = r.sueltasA;
    // 2) segunda asociacion: pistas que siguen sueltas con detecciones de baja confianza
    const restantes = sinPista.map((i) => grupo[i]).filter((t) => t.estado === SEGUIDO);
    let sueltasR;
    if (restantes.length && segundas.length) {
      let d = distanciaIoU(restantes, segundas);
      if (this.fusionar) d = fusionarPuntaje(d, segundas);
      const r2 = asignacionConLimite(d, 0.5, segundas.length);
      for (const [it, id] of r2.pares) aplicar(restantes[it], segundas[id]);
      sueltasR = r2.sueltasA;
    } else sueltasR = restantes.map((_, i) => i);
    for (const i of sueltasR) {
      const t = restantes[i];
      if (t.estado !== PERDIDO) { t.estado = PERDIDO; perdidas.push(t); }
    }
    // 3) pistas sin confirmar con las detecciones que sobraron
    detecciones = sueltasDet.map((i) => detecciones[i]);
    let nuevas = detecciones.map((_, i) => i);
    if (sinConfirmar.length) {
      const r3 = asignacionConLimite(this.distancias(sinConfirmar, detecciones), 0.7, detecciones.length);
      for (const [it, id] of r3.pares) { sinConfirmar[it].actualizar(detecciones[id], this.cuadro); activadas.push(sinConfirmar[it]); }
      for (const it of r3.sueltasA) { sinConfirmar[it].estado = ELIMINADO; eliminadas.push(sinConfirmar[it]); }
      nuevas = r3.sueltasB;
    }
    // 4) pistas nuevas
    for (const i of nuevas) {
      const t = detecciones[i];
      if (t.score < this.nuevo) continue;
      t.activar(this.cuadro, this);
      activadas.push(t);
    }
    // 5) pistas perdidas hace mucho
    for (const t of this.perdidas) {
      if (this.cuadro - t.cuadro > this.memoria) { t.estado = ELIMINADO; eliminadas.push(t); }
    }
    // merge_track_pools
    this.seguidas = this.seguidas.filter((t) => t.estado === SEGUIDO);
    this.seguidas = unir(this.seguidas, activadas);
    this.seguidas = unir(this.seguidas, reencontradas);
    this.perdidas = restar(this.perdidas, this.seguidas);
    this.perdidas.push(...perdidas);
    this.perdidas = restar(this.perdidas, this.eliminadas);
    [this.seguidas, this.perdidas] = quitarDuplicados(this.seguidas, this.perdidas);
    this.eliminadas.push(...eliminadas);
    if (this.eliminadas.length > 1000) this.eliminadas = this.eliminadas.slice(-1000);
    return this.seguidas.filter((t) => t.activada).map((t) => [...t.xywha(), t.id, t.score, t.idx]);
  }
}

// ------------------------------------------------------------------ cajas (x, y, w, h)
export const centro = ([x, y, w, h]) => [x + w / 2, y + h / 2];
export function iouCajas([ax, ay, aw, ah], [bx, by, bw, bh]) {
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by), x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}
export function contencion([ix, iy, iw, ih], [ex, ey, ew, eh]) {
  const x1 = Math.max(ix, ex), y1 = Math.max(iy, ey), x2 = Math.min(ix + iw, ex + ew), y2 = Math.min(iy + ih, ey + eh);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / Math.max(1, iw * ih);
}
const expandir = ([x, y, w, h], m) => [x - m, y - m, w + 2 * m, h + 2 * m];
const seTocan = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
const ascendente = (s) => [...s].sort((a, b) => a - b);

// ------------------------------------------------------------------ identidades de la flota
const INVALIDO = 1e6;

/** FleetIdentityManager (deteccion_camiones.py), con los parametros que usa motor.py. */
export class Flota {
  constructor(fps = 30, o = {}) {
    const f = (s) => Math.max(1, redondear(fps * s));
    Object.assign(this, {
      maxCamiones: 40, distanciaBase: 120, distanciaMax: 400, crecimiento: 4.0, proporcion: 2.0,
      bono: 0.15, prediccionMax: 60, suavizado: 0.6, antesDeForzar: 3, velocidadQuieto: 0.4,
      paraAnclar: 15, radioAnclado: 20, liberarAncla: 150, contencionFusion: 0.6, maxOculto: 150,
      margenPerturbacion: 30, postPerturbacion: f(0.7), iouMinProtegido: 0.4, confirmarSalida: 8,
      ancho: 800, alto: 600, confirmarFuera: f(1.0), olvidar: f(60.0), confirmarEntrada: f(0.5),
    }, o);
    this.salidas = []; this.tentativos = []; this.primerCuadro = null;
    this.registros = new Map(); this.estados = new Map(); this.internoAPersistente = new Map();
  }
  prediccion(r, n) {
    const dt = Math.min(Math.max(1, n - r.ultimo), this.prediccionMax);
    return r.caja.map((v, i) => v + r.vel[i] * dt);
  }
  anclado(r, n) { return r.quieto >= this.paraAnclar && n - r.ultimo <= this.liberarAncla; }
  puerta(r, n) {
    if (this.anclado(r, n)) return this.radioAnclado;
    return Math.min(this.distanciaMax, this.distanciaBase + this.crecimiento * Math.max(0, n - r.ultimo - 1));
  }
  enBorde([x, y, w, h], factor = 0.6) {
    const m = Math.max(6.0, factor * Math.max(w, h));
    return x < m || y < m || x + w > this.ancho - m || y + h > this.alto - m;
  }
  saliendo(r, n) {
    if (!r.caja || this.anclado(r, n) || !this.enBorde(r.caja)) return false;
    const [x, y, w, h] = r.caja;
    if (x <= 2 || y <= 2 || x + w >= this.ancho - 2 || y + h >= this.alto - 2) return true;
    const [vx, vy] = r.vel, cx = x + w / 2, cy = y + h / 2;
    const opciones = [[[-1, 0], cx], [[1, 0], this.ancho - cx], [[0, -1], cy], [[0, 1], this.alto - cy]];
    let mejor = opciones[0];
    for (const o of opciones) if (o[1] < mejor[1]) mejor = o;
    const [dx, dy] = mejor[0];
    return vx * dx + vy * dy > 0.05;
  }
  protegido(r, n) { return (r.perturbadoHasta ?? -1) >= n; }
  esDuplicado(caja, pred, n) {
    const [cx, cy] = centro(caja);
    for (const [pid, p] of pred) {
      const r = this.registros.get(pid);
      if (r.estado === "FUERA" || n - r.ultimo > this.confirmarFuera) continue;
      if (iouCajas(caja, p) > 0.15 || contencion(caja, p) > 0.35 || contencion(p, caja) > 0.35) return true;
      if (this.anclado(r, n) || this.protegido(r, n)) {
        const [px, py] = centro(p);
        if (Math.hypot(cx - px, cy - py) < 1.0 * Math.max(p[2], p[3])) return true;
      }
    }
    return false;
  }
  vivos() { let k = 0; for (const r of this.registros.values()) if (r.estado !== "FUERA") k++; return k; }
  nuevo() {
    const pid = this.registros.size + 1;
    this.registros.set(pid, { interno: null, caja: null, vel: [0, 0, 0, 0], ultimo: 0, estado: "LOST", quieto: 0,
                              perturbadoHasta: -1, congelada: null });
    return pid;
  }
  candidato(caja, pred, n) {
    if (this.primerCuadro === null) this.primerCuadro = n;
    if (this.vivos() >= this.maxCamiones || this.esDuplicado(caja, pred, n)) return null;
    if (n - this.primerCuadro <= 1) return this.nuevo();
    const [cx, cy] = centro(caja), tam = Math.max(caja[2], caja[3]);
    let mejor = null;
    for (const t of this.tentativos) {
      const [tx, ty] = centro(t.caja);
      if (n !== t.ultimo && (iouCajas(caja, t.caja) > 0.3 || Math.hypot(cx - tx, cy - ty) < 1.5 * tam)) { mejor = t; break; }
    }
    if (!mejor) { this.tentativos.push({ caja, primero: n, ultimo: n, veces: 1 }); return null; }
    Object.assign(mejor, { caja, ultimo: n, veces: mejor.veces + 1 });
    if (mejor.veces >= 3 && n - mejor.primero >= this.confirmarEntrada) {
      this.tentativos.splice(this.tentativos.indexOf(mejor), 1);
      return this.nuevo();
    }
    return null;
  }
  salioPorBorde(r) {
    if (!r.caja) return false;
    const [x, y, w, h] = r.caja;
    return x <= 2 || y <= 2 || x + w >= this.ancho - 2 || y + h >= this.alto - 2;
  }
  static pisaAOtro(caja, pid, activos) {
    for (const [otro, p] of activos) {
      if (otro === pid) continue;
      if (iouCajas(caja, p) > 0.3 || contencion(caja, p) > 0.5 || contencion(p, caja) > 0.5) return true;
    }
    return false;
  }
  noPuedeTomar(r, pid, caja, activos) {
    if (r.estado === "ACTIVE") return false;
    if (Flota.pisaAOtro(caja, pid, activos)) return true;
    return this.salioPorBorde(r) && !this.enBorde(caja);
  }
  confirmaSalida(pid, caja, pred, moviles) {
    const r = this.registros.get(pid), cong = r.congelada;
    const tocaMovil = moviles.some((m) => m !== pid && (contencion(caja, pred.get(m)) > 0.05 || contencion(pred.get(m), caja) > 0.05));
    const [, , w, h] = caja, [, , cw, ch] = cong;
    const tamOk = Math.max(w, cw) / Math.max(1, Math.min(w, cw)) <= 1.4 && Math.max(h, ch) / Math.max(1, Math.min(h, ch)) <= 1.4;
    const previa = r.salidaCaja ?? null;
    const coherente = previa === null || iouCajas(caja, previa) >= 0.6;
    if (!tocaMovil && tamOk && coherente) { r.salidaFrames = (r.salidaFrames || 0) + 1; r.salidaCaja = caja; }
    else { r.salidaFrames = 0; r.salidaCaja = null; }
    return r.salidaFrames >= this.confirmarSalida;
  }
  coste(r, caja, interno, n) {
    if (this.protegido(r, n)) {
      const cong = r.congelada, [cx, cy] = centro(caja), [px, py] = centro(cong), iou = iouCajas(caja, cong);
      if (Math.hypot(cx - px, cy - py) > this.radioAnclado || iou < this.iouMinProtegido) return INVALIDO;
      return 1 - iou;
    }
    const p = this.prediccion(r, n), [cx, cy] = centro(caja), [px, py] = centro(p);
    const d = Math.hypot(cx - px, cy - py);
    if (d > this.puerta(r, n)) return INVALIDO;
    const [, , w, h] = caja, pw = Math.max(1, p[2]), ph = Math.max(1, p[3]);
    if (Math.max(w, pw) / Math.max(1, Math.min(w, pw)) > this.proporcion || Math.max(h, ph) / Math.max(1, Math.min(h, ph)) > this.proporcion) return INVALIDO;
    let c = d / this.distanciaBase + 0.25 * Math.abs(Math.log(Math.max(1, w * h) / (pw * ph))) + 0.5 * (1 - iouCajas(caja, p));
    if (r.interno === interno) c -= this.bono;
    return c;
  }

  /** observaciones: [[interno, [x, y, w, h]]]. Devuelve [[pid, caja, interno]] (como actualizar() de Python). */
  actualizar(obs, n) {
    const reg = this.registros;
    const conocidos = new Map([...reg].filter(([, r]) => r.caja && r.estado !== "FUERA"));
    const pred = new Map([...conocidos].map(([pid, r]) => [pid, this.prediccion(r, n)]));
    // 0) proteger la cola cuando pasa un camion en movimiento
    const moviles = [...conocidos].filter(([, r]) => !this.anclado(r, n) && n - r.ultimo <= this.postPerturbacion).map(([p]) => p);
    for (const [pid, r] of conocidos) {
      if (!this.anclado(r, n)) continue;
      const entorno = expandir(r.caja, this.margenPerturbacion);
      if (moviles.some((m) => m !== pid && seTocan(pred.get(m), entorno))) {
        if (!this.protegido(r, n)) r.congelada = r.caja;
        r.perturbadoHasta = n + this.postPerturbacion;
      }
    }
    let cambio = true;
    while (cambio) {
      cambio = false;
      const ahora = [...conocidos].filter(([, r]) => this.protegido(r, n)).map(([p]) => p);
      for (const [, r] of conocidos) {
        if (this.protegido(r, n) || !this.anclado(r, n)) continue;
        const entorno = expandir(r.caja, this.margenPerturbacion);
        const vecino = ahora.find((p) => seTocan(reg.get(p).congelada, entorno));
        if (vecino !== undefined) { r.congelada = r.caja; r.perturbadoHasta = reg.get(vecino).perturbadoHasta; cambio = true; }
      }
    }
    const protegidos = new Set([...conocidos].filter(([, r]) => this.protegido(r, n)).map(([p]) => p));
    for (const pid of protegidos) pred.set(pid, reg.get(pid).congelada);
    // 1) cajas fusionadas
    const ocultos = new Set(), fusionadas = new Set();
    obs.forEach(([, caja], i) => {
      const dentro = [...conocidos].filter(([pid, r]) => r.estado === "ACTIVE" && contencion(pred.get(pid), caja) >= this.contencionFusion).map(([p]) => p);
      if (dentro.length >= 2) { fusionadas.add(i); dentro.forEach((p) => ocultos.add(p)); }
    });
    const validas = obs.map((_, i) => i).filter((i) => !fusionadas.has(i));
    const activos = new Map([...conocidos].filter(([, r]) => r.estado === "ACTIVE").map(([p]) => [p, pred.get(p)]));
    const candidatos = [...conocidos.keys()].filter((p) => !ocultos.has(p));
    const asig = new Map();
    // 2) asignacion global
    if (validas.length && candidatos.length) {
      const m = validas.map((i) => {
        const [interno, caja] = obs[i];
        return candidatos.map((pid) => (this.noPuedeTomar(conocidos.get(pid), pid, caja, activos) ? INVALIDO
          : this.coste(conocidos.get(pid), caja, interno, n)));
      });
      const [fs, cs] = asignacionLineal(m);
      fs.forEach((a, k) => { if (m[a][cs[k]] < INVALIDO) asig.set(validas[a], candidatos[cs[k]]); });
    }
    // 3) detecciones sueltas
    const usados = new Set([...asig.values(), ...ocultos, ...protegidos]);
    const sueltas = [], conCandidata = new Set();
    for (const i of validas) {
      if (asig.has(i)) continue;
      const caja = obs[i][1];
      const cubiertos = [...protegidos].filter((p) => contencion(caja, reg.get(p).congelada) >= 0.3 || contencion(reg.get(p).congelada, caja) >= 0.3);
      const [cx, cy] = centro(caja);
      let cercano = null, dist = 3 * this.radioAnclado;
      for (const p of protegidos) {
        const [px, py] = centro(reg.get(p).congelada), d = Math.hypot(cx - px, cy - py);
        if (d <= dist) { cercano = p; dist = d; }
      }
      if (cercano !== null && !conCandidata.has(cercano)) {
        conCandidata.add(cercano);
        if (this.confirmaSalida(cercano, caja, pred, moviles)) {
          Object.assign(reg.get(cercano), { perturbadoHasta: -1, quieto: 0, salidaFrames: 0, salidaCaja: null });
          protegidos.delete(cercano);
          asig.set(i, cercano);
          continue;
        }
      }
      if (cubiertos.length) continue;
      sueltas.push(i);
    }
    for (const p of protegidos) if (!conCandidata.has(p)) Object.assign(reg.get(p), { salidaFrames: 0, salidaCaja: null });
    const restantes = [];
    for (const i of sueltas) {
      if (this.enBorde(obs[i][1], 0.35)) {
        const pid = this.candidato(obs[i][1], pred, n);
        if (pid !== null) { asig.set(i, pid); usados.add(pid); }
      } else restantes.push(i);
    }
    const elegibles = [...reg].filter(([pid, r]) => !usados.has(pid) && r.caja && r.estado !== "FUERA" && n - r.ultimo >= this.antesDeForzar).map(([p]) => p);
    const entregadas = new Map([...asig].map(([i, pid]) => [pid, obs[i][1]]));
    for (const pid of ascendente(new Set([...ocultos, ...protegidos]))) if (pred.has(pid)) entregadas.set(pid, pred.get(pid));
    if (restantes.length && elegibles.length) {
      const m = restantes.map((i) => {
        const fila = new Array(elegibles.length).fill(INVALIDO);
        if (Flota.pisaAOtro(obs[i][1], null, entregadas)) return fila;
        const [cx, cy] = centro(obs[i][1]);
        elegibles.forEach((pid, b) => {
          const r = reg.get(pid), [lx, ly] = centro(r.caja), d = Math.hypot(cx - lx, cy - ly);
          if (this.anclado(r, n) && d > this.radioAnclado * 3) return;
          if (d > this.distanciaMax) return;
          if (this.salioPorBorde(r) && !this.enBorde(obs[i][1])) return;
          fila[b] = d;
        });
        return fila;
      });
      const [fs, cs] = asignacionLineal(m);
      fs.forEach((a, k) => { if (m[a][cs[k]] < INVALIDO) { asig.set(restantes[a], elegibles[cs[k]]); usados.add(elegibles[cs[k]]); } });
    }
    for (const i of restantes) {
      if (asig.has(i)) continue;
      const pid = this.candidato(obs[i][1], pred, n);
      if (pid !== null) { asig.set(i, pid); usados.add(pid); }
    }
    this.tentativos = this.tentativos.filter((t) => n - t.ultimo <= Math.max(3, Math.floor(this.confirmarEntrada / 2)));
    // 4) estados
    const res = [];
    this.estados = new Map(); this.internoAPersistente = new Map();
    obs.forEach(([interno, caja], i) => {
      const pid = asig.get(i);
      if (pid === undefined) return;
      const r = reg.get(pid);
      if (protegidos.has(pid)) {
        Object.assign(r, { ultimo: n, interno, estado: "ACTIVE", ocultoDesde: null });
        this.internoAPersistente.set(interno, pid);
        res.push([pid, r.congelada, interno]);
        this.estados.set(pid, "PROTEGIDO");
        return;
      }
      if (r.caja) {
        const dt = Math.max(1, n - r.ultimo), nueva = caja.map((a, k) => (a - r.caja[k]) / dt);
        if (r.estado === "LOST") r.vel = nueva;
        else { const s = this.suavizado; r.vel = r.vel.map((v, k) => s * v + (1 - s) * nueva[k]); }
        if (Math.hypot(r.vel[0], r.vel[1]) < this.velocidadQuieto) r.quieto += dt; else r.quieto = 0;
      }
      Object.assign(r, { caja, ultimo: n, interno, estado: "ACTIVE", ocultoDesde: null });
      this.internoAPersistente.set(interno, pid);
      res.push([pid, caja, interno]);
      this.estados.set(pid, "DETECTADO");
    });
    for (const pid of ascendente(ocultos)) {
      if (protegidos.has(pid)) continue;
      const r = reg.get(pid);
      if (r.ocultoDesde == null) r.ocultoDesde = n;
      if (n - r.ocultoDesde > this.maxOculto) { r.estado = "LOST"; continue; }
      res.push([pid, pred.get(pid).map(entero), null]);
      this.estados.set(pid, "PREDICHO");
    }
    const incluidos = new Set(res.map((x) => x[0]));
    for (const pid of ascendente(protegidos)) {
      if (incluidos.has(pid)) continue;
      const r = reg.get(pid);
      r.estado = "ACTIVE";
      res.push([pid, r.congelada.map(entero), null]);
      this.estados.set(pid, "PROTEGIDO");
    }
    for (const [pid, r] of reg) {
      if (!usados.has(pid) && r.estado === "ACTIVE") {
        r.estado = "LOST"; r.ocultoDesde = null; r.salidaVel = r.vel; r.vel = r.vel.map((v) => v * 0.5);
      }
    }
    // 5) salidas por el borde
    for (const [pid, r] of reg) {
      if (r.estado !== "LOST" || !r.caja) continue;
      const perdido = n - r.ultimo;
      if (perdido >= this.confirmarFuera) {
        const original = r.vel;
        r.vel = r.salidaVel ?? original;
        const sale = this.saliendo(r, n);
        r.vel = original;
        if (sale) { r.estado = "FUERA"; this.salidas.push([pid, r.ultimo]); continue; }
      }
      if (perdido >= this.olvidar && !this.anclado(r, n)) r.estado = "FUERA";
    }
    return res;
  }
}
