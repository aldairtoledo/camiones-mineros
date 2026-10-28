// Paso a paso del motor (motor.py, Motor.siguiente) para el modo en vivo: recibe las detecciones
// de YOLO de cada cuadro (en el cuadro de trabajo de 800 x 600) y devuelve la fila del cuadro con
// el mismo formato que demo.json:  [n, inferido, activos, filas, crudas]
//   filas:  [pid, x, y, w, h, km/h, estado (D, P, E), poligono relativo al centro]
//   crudas: [pid, x, y, w, h]  (las cajas con las que se cuenta en las zonas)
import { ByteTrack, Flota, esquinas, iouCajas, centro, redondear } from "./seguimiento.js";

export const ANCHO_TRABAJO = 800, ALTO_TRABAJO = 600;
export const SALTOS = { "Precisión": 1, "Equilibrado": 1.25, "Rápido": 1.5 };   // exportar_demo.MODOS
const SUAVIZADO_VISUAL = 0.5;
const ESTADO_CORTO = { DETECTADO: "D", PROTEGIDO: "P", PREDICHO: "E" };
const f = Math.fround;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Esquinas y caja recta de una caja rotada, con la misma precision (float32) que Ultralytics. */
function geometria(x, y, w, h, a) {
  const co = f(Math.cos(f(a))), si = f(Math.sin(f(a)));
  const v1 = [f(f(f(w) / 2) * co), f(f(f(w) / 2) * si)], v2 = [f(f(-f(h) / 2) * si), f(f(f(h) / 2) * co)];
  const cx = f(x), cy = f(y);
  const p = [[f(f(cx + v1[0]) + v2[0]), f(f(cy + v1[1]) + v2[1])], [f(f(cx + v1[0]) - v2[0]), f(f(cy + v1[1]) - v2[1])],
             [f(f(cx - v1[0]) - v2[0]), f(f(cy - v1[1]) - v2[1])], [f(f(cx - v1[0]) + v2[0]), f(f(cy - v1[1]) + v2[1])]];
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return { poli: p, xyxy: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

export class MotorVivo {
  /** fps: cuadros por segundo con que se numeran los cuadros; salto: 1, 1.25 o 1.5 (cada cuantos corre YOLO). */
  constructor({ fps = 30, salto = 1 } = {}) {
    this.fps = fps;
    this.salto = salto;
    this.rastreador = new ByteTrack();
    this.flota = new Flota(fps);
    this.contador = 0;
    this.cajasVisuales = new Map();
    this.poligonos = new Map();
    this.ultimasCrudas = [];
  }

  /** ¿En el proximo cuadro corre YOLO? (Motor._debe_inferir) */
  debeInferir(n = this.contador + 1) {
    const s = this.salto;
    return s <= 1 || n === 1 || Math.trunc(n / s) !== Math.trunc((n - 1) / s);
  }

  tiempo() { return this.contador / this.fps; }

  /**
   * Avanza un cuadro. dets: detecciones de YOLO [[x, y, w, h, angulo, conf], ...] ordenadas por
   * confianza, o null si en este cuadro no corre YOLO. Devuelve la fila del cuadro.
   */
  paso(dets) {
    this.contador += 1;
    const n = this.contador, inferido = dets != null;
    let crudas = [];
    if (inferido) {
      const pistas = this.rastreador.actualizar(dets);
      const obs = [], poliInt = new Map();
      for (const [x, y, w, h, a, id] of pistas) {
        const { poli, xyxy: [x1, y1, x2, y2] } = geometria(x, y, w, h, a);
        const caja = [Math.trunc(x1), Math.trunc(y1), Math.max(1, Math.trunc(x2 - x1)), Math.max(1, Math.trunc(y2 - y1))];
        obs.push([id, caja]);
        const [cx, cy] = centro(caja);
        poliInt.set(id, poli.map(([px, py]) => [px - cx, py - cy]));
      }
      const tracks = [];
      for (const [pid, caja, interno] of this.flota.actualizar(obs, n)) {
        tracks.push([pid, caja]);
        if (poliInt.has(interno) && this.flota.estados.get(pid) === "DETECTADO") this.poligonos.set(pid, poliInt.get(interno));
        const anterior = this.cajasVisuales.get(pid);
        if (anterior && iouCajas(anterior, caja) > 0.3) {
          const s = SUAVIZADO_VISUAL;
          this.cajasVisuales.set(pid, anterior.map((a, k) => redondear(s * a + (1 - s) * caja[k])));
        } else this.cajasVisuales.set(pid, caja);
      }
      crudas = tracks.map(([pid, c]) => [pid, Math.trunc(c[0]), Math.trunc(c[1]), Math.trunc(c[2]), Math.trunc(c[3])]);
      this.ultimasCrudas = crudas;
    } else {
      for (const [pid, r] of this.flota.registros) {
        if (r.estado === "ACTIVE" && r.caja) {
          const dt = n - r.ultimo;
          this.cajasVisuales.set(pid, r.caja.map((v, k) => Math.max(1, Math.trunc(v + r.vel[k] * dt))));
        }
      }
    }
    const estados = inferido ? this.flota.estados : new Map();
    const filas = [];
    for (const [pid, [x, y, w, h]] of this.cajasVisuales) {
      if (this.flota.registros.get(pid)?.estado !== "ACTIVE") continue;
      const poli = this.poligonos.get(pid);
      filas.push([pid, x, y, w, h, null, ESTADO_CORTO[estados.get(pid)] || "", poli ? poli.flat().map(r3) : null]);
    }
    let activos = 0;
    for (const r of this.flota.registros.values()) if (r.estado === "ACTIVE") activos++;
    return [n, inferido ? 1 : 0, activos, filas, crudas];
  }
}
