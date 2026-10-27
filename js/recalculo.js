// Recalcula en el navegador lo que depende de las zonas y del limite de velocidad, con las
// MISMAS reglas que motor.py (_contar, limite_en y _revisar_limite) y eventos.py (_avisar).
// La deteccion y el seguimiento NO se recalculan: vienen del analisis hecho en la laptop.

const ESPERA = { ENTRADA_ZONA: 3.0, EXCESO_VELOCIDAD: 8.0 };       // eventos.py
const TIPOS_RECALCULADOS = new Set(["ENTRADA_ZONA", "EXCESO_VELOCIDAD", "ACERCAMIENTO"]);

// Python redondea las mitades al par (round(4.5) = 4); JavaScript hacia arriba. Se imita Python.
export function redondearPar(x) {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

export function g(v) {                       // formato ":g" de Python (sin ceros sobrantes)
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
}

// ---------------------------------------------------------------- geometria
export function area(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function puntoEnPoligono(x, y, p) {
  // Incluye el borde (como el relleno de cv2.fillPoly).
  let dentro = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    const cruz = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
    if (Math.abs(cruz) < 1e-9 && Math.min(xi, xj) - 1e-9 <= x && x <= Math.max(xi, xj) + 1e-9 &&
        Math.min(yi, yj) - 1e-9 <= y && y <= Math.max(yi, yj) + 1e-9) return true;
    if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) dentro = !dentro;
  }
  return dentro;
}

// ---------------------------------------------------------------- pixeles (como cv2.fillPoly)
// El motor mide la parte del camion dentro de la zona contando PIXELES de dos mascaras
// rellenadas con cv2.fillPoly. Para que los conteos salgan iguales se rellena igual:
// interior por lineas horizontales + el contorno dibujado con lineas de 8 vecinos.
function rellenar(puntos, ancho, alto, x0 = 0, y0 = 0) {
  const m = new Uint8Array(ancho * alto);
  const pon = (x, y) => {
    x -= x0; y -= y0;
    if (x >= 0 && y >= 0 && x < ancho && y < alto) m[y * ancho + x] = 1;
  };
  const n = puntos.length;
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of puntos) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  for (let y = Math.max(ymin, y0); y <= Math.min(ymax, y0 + alto - 1); y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const [xa, ya] = puntos[i], [xb, yb] = puntos[(i + 1) % n];
      if ((ya <= y && yb > y) || (yb <= y && ya > y)) xs.push(xa + (y - ya) * (xb - xa) / (yb - ya));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) pon(x, y);
    }
  }
  for (let i = 0; i < n; i++) {                      // contorno: igual que cv2.line (8 vecinos)
    let [xa, ya] = puntos[i], [xb, yb] = puntos[(i + 1) % n];
    if (xa > xb) [xa, ya, xb, yb] = [xb, yb, xa, ya];  // OpenCV recorre de izquierda a derecha
    let dx = xb - xa, dy = yb - ya;
    const sy = dy < 0 ? -1 : 1;
    dy = Math.abs(dy);
    const vertical = dy > dx;
    if (vertical) [dx, dy] = [dy, dx];
    let err = dx - (dy + dy);
    let x = xa, y = ya;
    for (let k = 0; k <= dx; k++) {
      pon(x, y);
      const menor = err < 0;
      err += -(dy + dy) + (menor ? dx + dx : 0);
      if (vertical) { y += sy; if (menor) x += 1; } else { x += 1; if (menor) y += sy; }
    }
  }
  return m;
}

export function mascaraZona(puntos, ancho, alto) {
  const enteros = puntos.map(([x, y]) => [redondearPar(x), redondearPar(y)]);   // agregar_zona
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of enteros) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  return { m: rellenar(enteros, ancho, alto), ancho, alto, caja: [x1, y1, x2, y2] };
}

// Fraccion del camion dentro de la zona: motor.fraccion_dentro.
export function fraccionDentro(caja, zona, poligono) {
  const { m, ancho, alto } = zona;
  if (poligono) {
    const pts = poligono.map(([x, y]) => [redondearPar(x), redondearPar(y)]);
    const a = Math.max(1, Math.abs(area(pts)));
    let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    for (const [x, y] of pts) { bx1 = Math.min(bx1, x); by1 = Math.min(by1, y); bx2 = Math.max(bx2, x); by2 = Math.max(by2, y); }
    const x1 = Math.max(0, bx1), y1 = Math.max(0, by1), x2 = Math.min(ancho, bx2 + 1), y2 = Math.min(alto, by2 + 1);
    if (x2 <= x1 || y2 <= y1) return 0;
    const [zx1, zy1, zx2, zy2] = zona.caja;
    if (x2 <= zx1 || x1 > zx2 || y2 <= zy1 || y1 > zy2) return 0;
    const w = x2 - x1, h = y2 - y1;
    const local = rellenar(pts, w, h, x1, y1);
    let dentro = 0;
    for (let y = 0; y < h; y++) {
      const fila = (y + y1) * ancho + x1;
      for (let x = 0; x < w; x++) if (local[y * w + x] && m[fila + x]) dentro++;
    }
    return Math.min(1, dentro / a);
  }
  const [x, y, w, h] = caja;
  const a = Math.max(1, w * h);
  const x1 = Math.max(0, x), y1 = Math.max(0, y), x2 = Math.min(ancho, x + w), y2 = Math.min(alto, y + h);
  if (x2 <= x1 || y2 <= y1) return 0;
  let dentro = 0;
  for (let yy = y1; yy < y2; yy++) for (let xx = x1; xx < x2; xx++) if (m[yy * ancho + xx]) dentro++;
  return dentro / a;
}

// ---------------------------------------------------------------- recalculo completo
/**
 * demo: contenido de demo.json.  cfg: {zonas:[{puntos,tipo,nombre,limite}], limiteGeneral, georef}
 * Devuelve conteos por cuadro, limite vigente de cada camion y los avisos recalculados.
 */
export function recalcular(demo, cfg) {
  const p = demo.parametros;
  const fps = demo.fps;
  const N = demo.cuadros.length;
  const zonas = cfg.zonas;
  const Z = zonas.length;
  const [AW, AH] = demo.trabajo;
  const mascaras = zonas.map((zz) => mascaraZona(zz.puntos, AW, AH));
  const filtro = Math.max(1, redondearPar(fps * p.filtro_segundos / Math.max(1, demo.skip_frames)));
  const nombre = (z) => (zonas[z].nombre || "").trim() || `Zona ${z + 1}`;
  const conteos = new Int32Array(N * Math.max(Z, 1));
  const limites = new Array(N);
  const recorrido = new Array(N);
  const estadoZona = new Map(), consecutivos = new Map(), base = new Set();
  const totales = new Array(Z).fill(0), ocupacion = new Array(Z).fill(0);
  const ultimoAviso = new Map();
  const avisos = [];
  const eventosZona = [];
  // limites de velocidad
  const limiteActual = new Map(), excesoDesde = new Map(), excesoAvisado = new Set();
  const tInicio = new Map(), tVel = new Map(), est = new Map();
  // recorrido (para la ficha)
  const geo = cfg.georef;
  const fx = demo.resolucion[0] / demo.trabajo[0], fy = demo.resolucion[1] / demo.trabajo[1];
  const dist = new Map(), ultimoCentro = new Map();
  // Muestras cada 0.5 s con la misma regla que RegistroDatos.registrar (para el dashboard).
  const cadaMuestra = Math.max(1, redondearPar(0.5 * fps));
  let ultimaMuestra = null;
  const muestras = [];          // {n, t, presentes: Map pid -> [zonas dentro], ocupacion: [por zona]}
  const excesos = [];           // {t, pid, kmh, limite, zona}: cada vez que motor.est["excesos"] sube
  const tramosExceso = [];      // [t, pid, dt]: cada tramo en que el camion iba sobre el limite

  const avisar = (t, tipo, pid, titulo, detalle, extra, zona, corto) => {
    const clave = `${tipo}|${pid}|${extra}`;
    if (t - (ultimoAviso.has(clave) ? ultimoAviso.get(clave) : -1e9) < ESPERA[tipo]) return;
    ultimoAviso.set(clave, t);
    avisos.push({ tiempo_s: Math.round(t * 100) / 100, tipo, nivel: tipo === "EXCESO_VELOCIDAD" ? "alerta" : "info",
                  id_camion: pid, zona: zona ?? null, titulo, detalle, mensaje: `${titulo}: ${detalle}`,
                  corto: corto || `Camión ${pid}`, recalculado: true });
  };

  const limiteEn = (x, y) => {
    const xi = Math.trunc(Math.min(Math.max(x, 0), demo.trabajo[0] - 1));
    const yi = Math.trunc(Math.min(Math.max(y, 0), demo.trabajo[1] - 1));
    let mejor = null;
    zonas.forEach((zz, z) => {
      if (zz.limite && mascaras[z].m[yi * AW + xi] && (!mejor || zz.limite < mejor[0])) mejor = [zz.limite, nombre(z)];
    });
    if (mejor) return mejor;
    return cfg.limiteGeneral ? [cfg.limiteGeneral, null] : [null, null];
  };

  for (let i = 0; i < N; i++) {
    const [n, inferido, , filas, crudas] = demo.cuadros[i];
    const t = n / fps;
    if (inferido) {
      const porId = new Map(filas.map((f) => [f[0], f]));
      // --- conteo en zonas (motor._contar) ---
      for (const [pid, x, y, w, h] of crudas) {
        const f = porId.get(pid);
        let poligono = null;
        if (f && f[7]) {
          const cx = x + w / 2, cy = y + h / 2, q = f[7];
          poligono = [[q[0] + cx, q[1] + cy], [q[2] + cx, q[3] + cy], [q[4] + cx, q[5] + cy], [q[6] + cx, q[7] + cy]];
        }
        for (let z = 0; z < Z; z++) {
          const fr = fraccionDentro([x, y, w, h], mascaras[z], poligono);
          const observado = fr >= p.umbral_entrada_zona ? "dentro" : fr <= p.umbral_salida_zona ? "fuera" : null;
          const k = `${pid}|${z}`;
          const confirmado = estadoZona.get(k) || "fuera";
          if (observado === "dentro" && confirmado === "fuera") {
            consecutivos.set(k, (consecutivos.get(k) || 0) + 1);
            if (consecutivos.get(k) >= filtro) {
              totales[z] += 1;
              if (zonas[z].tipo === "dinamica") {
                if (t <= p.segundos_estado_inicial) base.add(k);
                else ocupacion[z] += 1;
              }
              estadoZona.set(k, "dentro");
              consecutivos.set(k, 0);
              eventosZona.push({ t, pid, z, tipo: "ENTRADA" });
              if (t > 1.0) avisar(t, "ENTRADA_ZONA", pid, `Entrada a ${nombre(z)}`,
                                  `El camión ${pid} entró a ${nombre(z)}.`, nombre(z), nombre(z));
            }
          } else if (observado === "fuera" && confirmado === "dentro") {
            consecutivos.set(k, (consecutivos.get(k) || 0) + 1);
            if (consecutivos.get(k) >= filtro) {
              estadoZona.set(k, "fuera");
              consecutivos.set(k, 0);
              if (zonas[z].tipo === "dinamica") {
                if (base.has(k)) base.delete(k);
                else ocupacion[z] = Math.max(0, ocupacion[z] - 1);
              }
              eventosZona.push({ t, pid, z, tipo: "SALIDA" });
            }
          } else {
            consecutivos.set(k, 0);
          }
        }
      }
      // --- limite de velocidad (motor._revisar_limite) y recorrido ---
      for (const [pid, x, y, w, h] of crudas) {
        const f = porId.get(pid);
        if (!f || f[6] !== "D") continue;
        const cx = x + w / 2, cy = y + h / 2;
        if (geo) {
          const ox = cx * fx, oy = cy * fy, prev = ultimoCentro.get(pid);
          if (!prev) ultimoCentro.set(pid, [ox, oy, t]);
          else if (t - prev[2] >= 0.2) {
            const d = Math.hypot(ox - prev[0], oy - prev[1]), v = d / (t - prev[2]);
            if (v >= 15 && v <= 1500) dist.set(pid, (dist.get(pid) || 0) + d * geo.escalaMPx);
            ultimoCentro.set(pid, [ox, oy, t]);
          }
        }
        if (!tInicio.has(pid)) tInicio.set(pid, t);
        const kmh = f[5];
        if (kmh == null || t - tInicio.get(pid) < p.segundos_sin_velocidad) continue;
        const dt = t - (tVel.has(pid) ? tVel.get(pid) : t);
        tVel.set(pid, t);
        const e = est.get(pid) || { vel_max: 0, t_exceso: 0, excesos: 0 };
        est.set(pid, e);
        e.vel_max = Math.max(e.vel_max, kmh);
        const [limite, zona] = limiteEn(cx, cy);
        limiteActual.set(pid, [limite, zona]);
        if (!limite || kmh <= limite + 1.0) {
          excesoDesde.delete(pid);
          if (!limite || kmh < limite - 2.0) excesoAvisado.delete(pid);
          continue;
        }
        e.t_exceso += Math.max(0, dt);
        if (dt > 0) tramosExceso.push([t, pid, dt]);       // para cortar el tiempo sobre el limite en T
        if (!excesoDesde.has(pid)) excesoDesde.set(pid, t);
        const inicio = excesoDesde.get(pid);
        if (t - inicio >= 1.0 && !excesoAvisado.has(pid)) {
          excesoAvisado.add(pid);
          e.excesos += 1;
          excesos.push({ t: inicio, pid, kmh, limite, zona });
          const donde = zona ? ` en ${zona}` : "";
          avisar(inicio, "EXCESO_VELOCIDAD", pid, "Exceso de velocidad",
                 `El camión ${pid} va a ${kmh.toFixed(0)} km/h; el límite${donde} es ${g(limite)} km/h.`,
                 null, null, `Camión ${pid} a ${kmh.toFixed(0)} km/h (máx. ${g(limite)}${donde})`);
        }
      }
    }
    if (inferido && (ultimaMuestra === null || n - ultimaMuestra >= cadaMuestra)) {
      ultimaMuestra = n;
      const presentes = new Map();
      const ocup = new Array(Z).fill(0);
      for (const [pid] of crudas) {
        const dentro = [];
        for (let z = 0; z < Z; z++) if (estadoZona.get(`${pid}|${z}`) === "dentro") { dentro.push(z); ocup[z]++; }
        presentes.set(pid, dentro);
      }
      muestras.push({ n, t, presentes, ocupacion: ocup });
    }
    for (let z = 0; z < Z; z++) conteos[i * Z + z] = zonas[z].tipo === "dinamica" ? ocupacion[z] : totales[z];
    limites[i] = filas.map((f) => limiteActual.get(f[0]) || [null, null]);
    recorrido[i] = filas.map((f) => (geo ? dist.get(f[0]) || 0 : null));
  }
  return { Z, conteos, limites, recorrido, avisos, eventosZona, estadisticas: est, muestras, excesos, tramosExceso };
}

/** Avisos a mostrar: los del analisis, con los de zonas y limites recalculados si algo cambio. */
export function combinarAvisos(demo, cfg, resultado, cambiado) {
  if (!cambiado) return demo.alertas.slice();
  const zonas = cfg.zonas;
  const nombre = (z) => (zonas[z].nombre || "").trim() || `Zona ${z + 1}`;
  const base = [];
  for (const a of demo.alertas) {
    if (TIPOS_RECALCULADOS.has(a.tipo)) continue;
    if (a.tipo === "DETENIDO") {
      // El lugar de la detencion depende de las zonas: se vuelve a ubicar el camion.
      const i = Math.min(demo.cuadros.length - 1, Math.max(0, Math.round(a.tiempo_s * demo.fps) - 1));
      const f = demo.cuadros[i][3].find((c) => c[0] === a.id_camion);
      let lugar = "";
      if (f) {
        const cx = f[1] + f[3] / 2, cy = f[2] + f[4] / 2;
        const z = zonas.findIndex((zz) => puntoEnPoligono(cx, cy, zz.puntos));
        if (z >= 0) lugar = ` en ${nombre(z)}`;
      }
      base.push({ ...a, detalle: `El camión ${a.id_camion} se detuvo${lugar}.`, corto: `Camión ${a.id_camion}${lugar}` });
      continue;
    }
    base.push(a);
  }
  return base.concat(resultado.avisos).sort((x, y) => x.tiempo_s - y.tiempo_s);
}
