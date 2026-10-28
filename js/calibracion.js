// Editor de calibracion de la web (pixeles -> metros), copia del dialogo "Calibrar coordenadas"
// de la app de escritorio (app.py, DialogoGeorref, modo "Plano local"): mismas formulas, mismos
// pesos, mismo "Ajuste sugerido", "Sugerencia para mas precision" y control de sentido comun.
//
// Como el video ya fue analizado, cambiar la escala NO obliga a analizarlo de nuevo: con un plano
// local todo lo medido (velocidades, distancias, posiciones en metros) es proporcional a la escala,
// asi que se multiplica por k = escala nueva / escala del analisis. Lo demas (zonas, conteos,
// limites y avisos de exceso) se recalcula en el navegador como siempre.
import { Georreferencia } from "./georef.js";

const ERROR_METODO_CAMION = 0.07;          // app.py: incertidumbre del metodo del camion
const UMBRAL_DESACUERDO = 0.15;            // camion vs distancias
const LARGO_RAZONABLE = [6.0, 20.0];       // control de sentido comun (m)
const DESVIO_TOLERADO = 0.25;
const COLOR_DIST = "#B388FF";
const OPCIONES = ["Solo camión", "Solo distancias", "Combinar ambos"];
const AYUDA = {
  "Solo camión": "La escala sale del tamaño de los camiones. Es rápida pero aproximada (± 5–10 %): sirve para empezar " +
                 "o comprobar, no como medida final.",
  "Solo distancias": "La escala sale de distancias que tú conoces entre dos puntos del video. Es precisa (± 1 % o menos " +
                     "con una distancia larga).",
  "Combinar ambos": "Usa el camión y tus distancias a la vez; cada medida pesa según su precisión (las distancias " +
                    "pesan mucho más que el camión).",
};

const $ = (id) => document.getElementById(id);
const hipot = Math.hypot;
const f1 = (v) => v.toFixed(1);
const miles = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const pct = (v) => `± ${v.toFixed(1)} %`;
const g = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function numero(texto) {
  let t = String(texto ?? "").trim().replace(/[\s ]/g, "");
  if ((t.match(/,/g) || []).length === 1 && !t.includes(".")) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  const v = parseFloat(t);
  return Number.isFinite(v) && /^-?\d*\.?\d+$/.test(t) ? v : null;
}
const mediana = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Plano local: (0; 0) en la esquina inferior izquierda, X a la derecha, Y hacia arriba (georreferencia.plano_local). */
export function planoLocal(ancho, alto, escala, e0 = 0, n0 = 0, info = {}) {
  const datos = { ...info, modo: "plano", origen_e: e0, origen_n: n0, escala_m_px: escala };
  return new Georreferencia([[0, alto, e0, n0], [ancho, alto, e0 + ancho * escala, n0]], datos);
}

// ---------------------------------------------------------------- escala de los datos ya analizados
/** Guarda los valores del analisis (para escalar siempre desde ellos, sin acumular redondeos). */
export function prepararEscala(demo) {
  const georef = Georreferencia.desdeDict(demo.calibracion);
  const kmh = new WeakMap();
  const tipica = [];
  for (const c of demo.cuadros) {
    for (const f of c[3]) {
      kmh.set(f, f[5]);
      if (f[6] === "D" && f[5] != null && f[5] >= 1.5) tipica.push(f[5]);
    }
  }
  return { georef, dict: demo.calibracion, kmh, velTipica: tipica.length >= 10 ? mediana(tipica) : null,
           editable: !!georef && georef.esPlano() };
}

export const factorEscala = (base, geo) => (base.georef && geo ? geo.escalaMPx / base.georef.escalaMPx : 1);

export function escalarDemo(base, demo, geo) {
  const k = factorEscala(base, geo);
  for (const c of demo.cuadros) {
    for (const f of c[3]) {
      const v = base.kmh.get(f);
      f[5] = v == null ? v : Math.round(v * k * 10) / 10;
    }
  }
  demo.calibracion = geo ? geo.aDict() : base.dict;
}

/** Posiciones y metros del tablero (resultados.json) con la nueva escala. */
export function escalarTablero(base, tablero, geo) {
  if (!tablero) return;
  const k = factorEscala(base, geo);
  if (!tablero._original) {
    tablero._original = {
      acum: (tablero.acumulados || []).map((f) => f[6]),
      tray: (tablero.trayectorias || []).map((f) => [f.x_m, f.y_m, f.velocidad_km_h]),
      calibracion: tablero.calibracion,
    };
  }
  const o = tablero._original;
  (tablero.acumulados || []).forEach((f, i) => { if (o.acum[i] != null) f[6] = Math.round(o.acum[i] * k * 1e4) / 1e4; });
  const [e0, n0] = geo ? geo.origenPlano() : [0, 0];
  (tablero.trayectorias || []).forEach((f, i) => {
    const [x, y, v] = o.tray[i];
    if (x != null) { f.x_m = Math.round(x * k * 100) / 100; if ("este_m" in f) f.este_m = Math.round((e0 + f.x_m) * 100) / 100; }
    if (y != null) { f.y_m = Math.round(y * k * 100) / 100; if ("norte_m" in f) f.norte_m = Math.round((n0 + f.y_m) * 100) / 100; }
    if (v != null) f.velocidad_km_h = Math.round(v * k * 10) / 10;
  });
  tablero.calibracion = geo ? geo.aDict() : o.calibracion;
}

// ---------------------------------------------------------------- medida de los camiones
function camionesMedidos(demo, base) {
  const muestras = (demo.camiones_calibracion || []).map((m) => ({
    t: m.t, camiones: m.camiones.map((c) => ({ ...c, poli: c.poli.map((p) => [...p]) })) }));
  if (muestras.length) return { muestras, respaldo: null };
  const i = base.georef?.info || {};
  // Exportaciones antiguas sin camiones medidos: se usa el largo con que se calibro el analisis.
  let largoPx = i.largo_px;
  if (!largoPx && i.largo_m && /^(Solo camión|Automática)/.test(String(i.fuente || ""))) largoPx = i.largo_m / base.georef.escalaMPx;
  return { muestras: [], respaldo: largoPx ? { n: i.camiones_medidos || 5, largo_px: largoPx, ancho_px: 0, variacion: 0.1 } : null };
}

function resumir(muestras, respaldo) {
  const usados = muestras.flatMap((m) => m.camiones.filter((c) => c.usado));
  if (!usados.length) return respaldo;
  const largos = usados.map((c) => c.largo).sort((a, b) => a - b), anchos = usados.map((c) => c.ancho);
  const largo = mediana(largos);
  const q1 = largos[Math.floor(0.25 * (largos.length - 1))], q3 = largos[Math.round(0.75 * (largos.length - 1))];
  return { n: usados.length, largo_px: largo, ancho_px: mediana(anchos), variacion: largo ? (q3 - q1) / largo : 0 };
}

// ---------------------------------------------------------------- el calculo (app.py _calcular_plano)
export function calcularPlano({ eleccion, largoM, anchoM, distancias, medida, resolucion, origen = [0, 0] }) {
  const [W, H] = resolucion;
  const validas = distancias.map((d, i) => ({ d, i, m: numero(d.m), px: hipot(d.p[2] - d.p[0], d.p[3] - d.p[1]) }))
    .filter((v) => v.m && v.m > 0 && v.px > 3);
  const fuentes = [];
  if (medida && largoM && largoM > 0) {
    const escalas = [largoM / medida.largo_px];
    if (anchoM && anchoM > 0 && medida.ancho_px > 0) escalas.push(anchoM / medida.ancho_px);
    const n = Math.max(1, medida.n);
    const dispersion = (medida.variacion ?? 0.1) / 1.35 / Math.sqrt(n);
    const pixel = 1.5 / Math.max(medida.largo_px, 1) / Math.sqrt(n);
    fuentes.push({ nombre: "camión", escala: escalas.reduce((s, v) => s + v, 0) / escalas.length,
                   u: hipot(dispersion, pixel, ERROR_METODO_CAMION) });
  }
  validas.forEach((v, k) => fuentes.push({ nombre: `D${v.i + 1}`, escala: v.m / v.px, u: hipot(1.5 * Math.SQRT2 / v.px, 0.01), v }));
  const usadas = eleccion === "Solo camión" ? fuentes.filter((f) => f.nombre === "camión")
    : eleccion === "Solo distancias" ? fuentes.filter((f) => f.nombre !== "camión") : fuentes;
  const r = { geo: null, lineas: [], conflicto: null, sugerencia: null, filas: new Map(), validas };
  if (!usadas.length) {
    r.falta = eleccion === "Solo distancias" ? "Agrega al menos una distancia con sus metros."
      : !medida ? "No hay camiones medidos en este video. Usa una distancia conocida."
      : "Escribe el largo del camión o agrega una distancia conocida.";
    return r;
  }
  const pesos = usadas.map((f) => 1 / (f.u * f.u));
  const sumaP = pesos.reduce((s, p) => s + p, 0);
  const escala = usadas.reduce((s, f, i) => s + pesos[i] * f.escala, 0) / sumaP;
  const incert = 1 / Math.sqrt(sumaP);
  const hayCamion = usadas.some((f) => f.nombre === "camión");
  const nDist = usadas.filter((f) => f.nombre !== "camión").length;
  const partes = [];
  if (hayCamion) partes.push(`camión de ${g(largoM)} m` + (anchoM ? ` x ${g(anchoM)} m` : ""));
  if (nDist) partes.push(`${nDist} distancia(s) conocida(s)`);
  const fuente = (usadas.length > 1 ? "Combinado: " : hayCamion ? "Solo camión: " : "Solo distancias: ") + partes.join(" + ");
  const precision = Math.max(1.5 * escala, 0.05);
  const info = {
    fuente, largo_m: largoM || null, ancho_m: anchoM || null,
    largo_px: medida ? Math.round(medida.largo_px * 10) / 10 : null, camiones_medidos: medida ? medida.n : 0,
    precision_m: Math.round(precision * 100) / 100, incertidumbre_escala_pct: Math.round(incert * 1000) / 10,
    distancias: validas.map((v) => [...v.d.p, v.m]), editada_web: true,
  };
  r.geo = planoLocal(W, H, escala, origen[0], origen[1], info);
  r.escala = escala;
  r.incert = incert;
  r.soloCamion = hayCamion && !nDist;
  r.lineas = [`${r.soloCamion ? "≈" : "✓"}  Escala: 1 m = ${f1(1 / escala)} píxeles del video`,
              `El video cubre ${miles(W * escala)} m × ${miles(H * escala)} m`,
              `Precisión aproximada de posición: ± ${precision.toFixed(2)} m`,
              `Precisión de distancias: ${pct(incert * 100)}`];
  if (usadas.length > 1) {
    r.lineas.push("Peso de cada medida: " + usadas.map((f, i) => `${f.nombre} ${Math.round(pesos[i] / sumaP * 100)} %`).join(", "));
  }
  // ¿Coinciden el camion y las distancias? Si no, se ofrece corregir con un clic.
  if (medida && largoM) {
    const c = {};
    const eCam = largoM / medida.largo_px;
    const eDist = validas.length ? validas.reduce((s, v) => s + v.m / v.px, 0) / validas.length : null;
    if (eleccion === "Combinar ambos" && eDist && Math.abs(eDist - eCam) / eCam > UMBRAL_DESACUERDO) {
      c.largoSegunDistancias = medida.largo_px * eDist;
      c.distanciasSegunCamion = validas.map((v) => [v.i, v.px * eCam]);
    }
    if (anchoM && medida.ancho_px > 0 && eleccion !== "Solo distancias") {
      const esperado = largoM * medida.ancho_px / medida.largo_px;
      if (Math.abs(esperado - anchoM) / anchoM > 0.25) c.anchoEsperado = esperado;
    }
    r.conflicto = Object.keys(c).length ? c : null;
  }
  if (eleccion === "Combinar ambos") r.sugerencia = sugerir(fuentes, validas, incert, anchoM, medida, W);
  for (const v of validas) {
    const calc = v.px * escala, dif = (calc - v.m) / v.m * 100;
    r.filas.set(v.i, { texto: `${Math.round(v.px)} px → ${f1(calc)} m (${dif >= 0 ? "+" : ""}${f1(dif)} %)`, ok: Math.abs(dif) <= 5 });
  }
  return r;
}

function sugerir(fuentes, validas, incert, anchoM, medida, anchoVideo) {
  const pesos = fuentes.reduce((s, f) => s + 1 / (f.u * f.u), 0);
  const conOtra = (px) => { const u = hipot(1.5 * Math.SQRT2 / px, 0.01); return 1 / Math.sqrt(pesos + 1 / (u * u)) * 100; };
  const actual = incert * 100, T = "Sugerencia para más precisión", ideal = anchoVideo * 0.6;
  if (!validas.length) return { titulo: T, texto: `Agrega una distancia conocida larga, de un lado a otro del video. La precisión pasaría de ${pct(actual)} a ${pct(conOtra(ideal))}.`, boton: true };
  const larga = Math.max(...validas.map((v) => v.px));
  if (larga < anchoVideo * 0.25) return { titulo: T, texto: `Tu distancia es corta (${Math.round(larga)} px) y un toque desviado pesa mucho. Marca una más larga: la precisión pasaría a ${pct(conOtra(ideal))}.`, boton: true };
  const ang = validas.map((v) => ((Math.atan2(v.d.p[3] - v.d.p[1], v.d.p[2] - v.d.p[0]) * 180 / Math.PI) % 180 + 180) % 180);
  let sep = 0;
  for (const a of ang) for (const b of ang) sep = Math.max(sep, Math.min(Math.abs(a - b), 180 - Math.abs(a - b)));
  if (sep < 45) {
    const dir = ang[0] < 45 || ang[0] > 135 ? "vertical" : "horizontal";
    return { titulo: T, texto: `Agrega una distancia ${dir}, cruzada a D${validas[0].i + 1}, para comprobar que el video no está estirado en un eje.`, boton: true };
  }
  if (!anchoM && medida) return { titulo: T, texto: "Si conoces el ancho del camión, escríbelo en el paso 1 para comprobar su tamaño.", boton: false };
  if (medida && medida.n < 5) return { titulo: T, texto: "Hay pocos camiones para medirlos bien. Una distancia más larga ayudaría.", boton: true };
  return { titulo: `✓  Calibración muy precisa (${pct(actual)})`, texto: "Camión y distancias coinciden. No hace falta agregar nada más.", boton: false, bien: true };
}

/** Vista previa del impacto y control de sentido comun (app.py _revisar_impacto). */
function impacto(r, { eleccion, largoM, medida, base }) {
  if (!r.geo) return null;
  const e = r.escala, [min, max] = LARGO_RAZONABLE;
  const esperado = largoM && largoM >= min && largoM <= max ? largoM : 15.0;
  let vel = null;
  if (base.velTipica && base.georef) {
    const k = e / base.georef.escalaMPx, vieja = base.velTipica, nueva = vieja * k;
    vel = Math.abs(k - 1) > 0.05 ? `velocidad típica ${Math.round(vieja)} → ${Math.round(nueva)} km/h` : `velocidad típica ${Math.round(nueva)} km/h`;
  }
  if (!medida) return vel ? { texto: `Con esta escala:  ${vel}`, nivel: "ok" } : null;
  const largo = medida.largo_px * e, desvio = largo / esperado - 1;
  if (eleccion === "Solo camión") {
    if (largoM && !(largoM >= min && largoM <= max)) {
      return { texto: `⚠  Un camión de ${g(largoM)} m no es común en minería (lo normal es 8–16 m). Revisa el largo escrito.`,
               nivel: "alerta", alerta: { largo: largoM, esperado: null } };
    }
  } else if (Math.abs(desvio) > DESVIO_TOLERADO && r.conflicto?.largoSegunDistancias) {
    return { texto: `Con esta escala:  camión ≈ ${Math.round(largo)} m  ⚠` + (vel ? `  ·  ${vel}` : ""), nivel: "aviso",
             alerta: { largo, esperado, factor: largo / esperado } };
  } else if (Math.abs(desvio) > DESVIO_TOLERADO) {
    const peor = r.validas.length && largoM ? r.validas.reduce((m, v) => (Math.abs(v.m / v.px / (largoM / medida.largo_px) - 1) >
      Math.abs(m.m / m.px / (largoM / medida.largo_px) - 1) ? v : m)) : null;
    const revisa = peor ? `Revisa los metros de D${peor.i + 1}.` : "Revisa tus distancias.";
    return { texto: `⚠  Con esta escala los camiones medirían ${Math.round(largo)} m (lo esperado es ≈ ${g(esperado)} m). ${revisa}` +
                    (vel ? `\nLas velocidades también cambian: ${vel}.` : ""),
             nivel: "alerta", alerta: { largo, esperado, factor: largo / esperado } };
  }
  return { texto: `Con esta escala:  camión ≈ ${f1(largo)} m  ✓` + (vel ? `  ·  ${vel}` : ""), nivel: "ok" };
}

// ---------------------------------------------------------------- la ventana
/**
 * ctx: { demo, base, georef (actual), video, alAplicar(geo), confirmar(titulo, texto, si, no) }
 */
export function abrirEditor(ctx) {
  const { demo, base } = ctx;
  const dlg = $("dlg-calib-editor"), lienzo = $("ce-lienzo"), c = lienzo.getContext("2d");
  const [W, H] = demo.resolucion;
  const medidos = camionesMedidos(demo, base);
  const info = ctx.georef?.info || {};
  const S = {
    eleccion: /^Solo distancias/.test(info.fuente || "") ? "Solo distancias" : /^Solo camión/.test(info.fuente || "") ? "Solo camión" : "Combinar ambos",
    distancias: (info.distancias || []).map(([x1, y1, x2, y2, m]) => ({ p: [x1, y1, x2, y2], m: g(m) })),
    midiendo: false, primer: null, cursor: null,
    vista: { zoom: 1, cx: W / 2, cy: H / 2 }, punteros: new Map(), gesto: null,
  };
  $("ce-largo").value = info.largo_m ? g(info.largo_m) : "15";
  $("ce-ancho").value = info.ancho_m ? g(info.ancho_m) : "";
  const origen = ctx.georef ? ctx.georef.origenPlano() : [0, 0];
  let R = null, imp = null;

  // muestra de camiones mas cercana al momento del video
  const t = ctx.video.currentTime || 0;
  const muestra = medidos.muestras.length
    ? medidos.muestras.reduce((m, x) => (Math.abs(x.t - t) < Math.abs(m.t - t) ? x : m)) : null;

  // ---- dibujo
  function geom() {
    const Wc = lienzo.clientWidth, Hc = lienzo.clientHeight;
    const e0 = Math.min(Wc / W, Hc / H), e = e0 * S.vista.zoom;
    const medioW = Wc / 2 / e, medioH = Hc / 2 / e;
    S.vista.cx = W * e0 * S.vista.zoom <= Wc ? W / 2 : Math.min(Math.max(S.vista.cx, medioW), W - medioW);
    S.vista.cy = H * e0 * S.vista.zoom <= Hc ? H / 2 : Math.min(Math.max(S.vista.cy, medioH), H - medioH);
    return { e, ox: Wc / 2 - S.vista.cx * e, oy: Hc / 2 - S.vista.cy * e, Wc, Hc };
  }
  const aLienzo = (x, y, G) => [G.ox + x * G.e, G.oy + y * G.e];
  const aVideo = (x, y, G) => [(x - G.ox) / G.e, (y - G.oy) / G.e];
  const dentro = ([x, y]) => x >= 0 && y >= 0 && x <= W && y <= H;

  function etiqueta(texto, x, y, fondo, color, ocupadas) {
    c.font = "600 11px IBM Plex Sans, Segoe UI, sans-serif";
    const w = c.measureText(texto).width + 10, h = 16;
    let yy = y;
    for (let k = 0; k < 8 && ocupadas.some((o) => x - w / 2 < o[2] && x + w / 2 > o[0] && yy - h / 2 < o[3] && yy + h / 2 > o[1]); k++) yy -= h + 3;
    ocupadas.push([x - w / 2, yy - h / 2, x + w / 2, yy + h / 2]);
    c.fillStyle = fondo; c.fillRect(x - w / 2, yy - h / 2, w, h);
    c.fillStyle = color; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(texto, x, yy + 0.5);
  }

  function pintar() {
    const dpr = window.devicePixelRatio || 1;
    const Wc = lienzo.clientWidth, Hc = lienzo.clientHeight;
    if (!Wc) return;
    if (lienzo.width !== Math.round(Wc * dpr)) lienzo.width = Math.round(Wc * dpr);
    if (lienzo.height !== Math.round(Hc * dpr)) lienzo.height = Math.round(Hc * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#1A1E25"; c.fillRect(0, 0, Wc, Hc);
    const G = geom();
    try {
      if (ctx.video.readyState >= 2) c.drawImage(ctx.video, G.ox, G.oy, W * G.e, H * G.e);
      else { c.fillStyle = "#2a2f38"; c.fillRect(G.ox, G.oy, W * G.e, H * G.e); }
    } catch { /* sin imagen */ }
    const escala = R?.geo ? R.escala : null;
    const ocupadas = [];
    // ejes del plano
    const [x0, y0] = aLienzo(0, H, G);
    c.strokeStyle = "#F2A900"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(x0 + 2, y0 - 2); c.lineTo(x0 + 70, y0 - 2); c.moveTo(x0 + 2, y0 - 2); c.lineTo(x0 + 2, y0 - 70); c.stroke();
    etiqueta("(0; 0)", x0 + 30, y0 - 16, "#12151A", "#F2A900", ocupadas);
    // camiones medidos
    if (muestra && S.eleccion !== "Solo distancias") {
      for (const cam of muestra.camiones) {
        const p = cam.poli.map(([x, y]) => aLienzo(x, y, G));
        c.setLineDash(cam.usado ? [] : [4, 3]);
        c.strokeStyle = cam.usado ? "#4CD964" : "#6B7280"; c.lineWidth = cam.usado ? 2 : 1;
        c.beginPath(); p.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
        c.setLineDash([]);
        if (escala) {
          const cx = p.reduce((s, q) => s + q[0], 0) / 4, cy = Math.min(...p.map((q) => q[1])) - 10;
          etiqueta(`${cam.usado ? "" : "✕ "}${f1(cam.largo * escala)} m`, cx, cy, "#12151A", cam.usado ? "#E8EAED" : "#9AA3AE", ocupadas);
        }
      }
    }
    // distancias
    S.distancias.forEach((d, i) => {
      const a = aLienzo(d.p[0], d.p[1], G), b = aLienzo(d.p[2], d.p[3], G);
      c.strokeStyle = "#12151A"; c.lineWidth = 6; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
      c.strokeStyle = COLOR_DIST; c.lineWidth = 3; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
      for (const [x, y] of [a, b]) { c.fillStyle = COLOR_DIST; c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill(); c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke(); }
      const m = numero(d.m);
      etiqueta(`D${i + 1}${m ? ` · ${g(m)} m` : ""}`, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14, COLOR_DIST, "#140A26", ocupadas);
    });
    // distancia en curso
    if (S.primer) {
      const a = aLienzo(...S.primer, G);
      c.strokeStyle = COLOR_DIST; c.lineWidth = 2; c.beginPath(); c.arc(a[0], a[1], 6, 0, 7); c.stroke();
      if (S.cursor) {
        c.setLineDash([5, 4]); c.beginPath(); c.moveTo(...a); c.lineTo(...aLienzo(...S.cursor, G)); c.stroke(); c.setLineDash([]);
      }
    }
    $("ce-zoom").textContent = S.vista.zoom > 1.001 ? `${Math.round(S.vista.zoom * 100)} %` : "100 %";
  }

  // ---- calculo y panel
  function medidaActual() { return resumir(medidos.muestras, medidos.respaldo); }

  function recalcular() {
    const largoM = numero($("ce-largo").value), anchoM = numero($("ce-ancho").value);
    const medida = medidaActual();
    R = calcularPlano({ eleccion: S.eleccion, largoM, anchoM, distancias: S.distancias, medida, resolucion: [W, H], origen });
    imp = impacto(R, { eleccion: S.eleccion, largoM, medida, base });
    // secciones visibles
    const secciones = { "Solo camión": ["camion"], "Solo distancias": ["dist"], "Combinar ambos": ["camion", "dist"] }[S.eleccion];
    $("ce-sec-camion").hidden = !secciones.includes("camion");
    $("ce-sec-dist").hidden = !secciones.includes("dist");
    $("ce-t-camion").textContent = `1.  Tamaño real del camión`;
    $("ce-t-dist").textContent = `${secciones.indexOf("dist") + 1}.  Distancias conocidas`;
    $("ce-ayuda").textContent = AYUDA[S.eleccion];
    document.querySelectorAll("#ce-eleccion button").forEach((b) => {
      b.classList.toggle("activo", b.dataset.v === S.eleccion);
      b.setAttribute("aria-checked", String(b.dataset.v === S.eleccion));
    });
    // camiones
    if (medidos.muestras.length) {
      const todos = medidos.muestras.flatMap((m) => m.camiones), usados = todos.filter((c) => c.usado).length;
      $("ce-medida").textContent = `Usando ${usados} de ${todos.length} camiones medidos a lo largo del video` +
        (todos.length - usados ? ` (${todos.length - usados} descartados: incompletos, en el borde o quitados por ti)` : "") +
        ". En la imagen: verde = se usa; toca un camión para quitarlo o volver a usarlo.";
    } else if (medidos.respaldo) {
      $("ce-medida").textContent = `Largo medido en el análisis: ${Math.round(medidos.respaldo.largo_px)} px.`;
    } else {
      $("ce-medida").textContent = "Este video no tiene camiones medidos: usa una distancia conocida.";
    }
    // lista de distancias
    const lista = $("ce-lista");
    lista.innerHTML = "";
    S.distancias.forEach((d, i) => {
      const fila = document.createElement("div");
      fila.className = "ce-fila";
      const extra = R.filas.get(i);
      fila.innerHTML = `<span class="ce-d">D${i + 1}</span><input type="text" inputmode="decimal" placeholder="metros" aria-label="Metros de D${i + 1}">` +
        `<span class="suave">m</span><small class="${extra ? (extra.ok ? "ce-ok" : "ce-aviso") : "suave"}">${esc(extra ? extra.texto : `${Math.round(hipot(d.p[2] - d.p[0], d.p[3] - d.p[1]))} px`)}</small>` +
        `<button class="ce-quitar" aria-label="Quitar D${i + 1}">✕</button>`;
      const entrada = fila.querySelector("input");
      entrada.value = d.m ?? "";
      entrada.addEventListener("input", () => { d.m = entrada.value; programar(); });
      fila.querySelector("button").addEventListener("click", () => { S.distancias.splice(i, 1); recalcular(); });
      lista.appendChild(fila);
    });
    // resumen, impacto, ajuste y consejo
    const res = $("ce-resumen");
    res.textContent = R.geo ? R.lineas.join("\n") : R.falta;
    res.classList.toggle("suave", !R.geo);
    const caja = $("ce-impacto");
    caja.hidden = !imp;
    if (imp) { caja.textContent = imp.texto; caja.className = `ce-caja ce-${imp.nivel}`; }
    pintarAjuste();
    pintarConsejo();
    $("ce-aplicar").disabled = !R.geo;
    pintar();
  }
  let tProg = null;
  const programar = () => { clearTimeout(tProg); tProg = setTimeout(() => {
    const foco = document.activeElement, idx = [...$("ce-lista").querySelectorAll("input")].indexOf(foco);
    const pos = foco?.selectionStart;
    recalcular();
    if (idx >= 0) { const e = $("ce-lista").querySelectorAll("input")[idx]; e?.focus(); try { e?.setSelectionRange(pos, pos); } catch { /* sin cursor */ } }
  }, 250); };

  function pintarAjuste() {
    const caja = $("ce-ajuste"), cf = S.eleccion === "Solo distancias" ? null : R.conflicto;
    caja.hidden = !cf;
    if (!cf) return;
    const largo = numero($("ce-largo").value);
    const partes = [], botones = [];
    if (cf.largoSegunDistancias) {
      partes.push(`El camión (${g(largo)} m) y tus distancias no coinciden en escala.`);
      botones.push([`Confiar en las distancias:  camión = ${f1(cf.largoSegunDistancias)} m`, () => {
        const ancho = numero($("ce-ancho").value);
        $("ce-largo").value = f1(cf.largoSegunDistancias);
        if (ancho && largo) $("ce-ancho").value = f1(ancho * cf.largoSegunDistancias / largo);
        recalcular();
      }]);
      const txt = cf.distanciasSegunCamion.map(([i, m]) => `D${i + 1} = ${Math.round(m)} m`).join(", ");
      botones.push([`Confiar en el camión:  ${txt}`, () => {
        for (const [i, m] of cf.distanciasSegunCamion) S.distancias[i].m = f1(m);
        recalcular();
      }]);
    }
    if (cf.anchoEsperado) {
      partes.push("El ancho no corresponde a la forma del camión en el video.");
      botones.push([`Corregir ancho a ${f1(cf.anchoEsperado)} m`, () => { $("ce-ancho").value = f1(cf.anchoEsperado); recalcular(); }]);
    }
    caja.innerHTML = `<b>⚠  Ajuste sugerido</b><p>${esc(partes.join(" "))} Elige qué dato es el correcto:</p>`;
    for (const [texto, accion] of botones) {
      const b = document.createElement("button");
      b.className = "boton";
      b.textContent = texto;
      b.addEventListener("click", accion);
      caja.appendChild(b);
    }
  }

  function pintarConsejo() {
    const caja = $("ce-consejo"), s = R.conflicto ? null : R.sugerencia;
    caja.hidden = !s;
    if (!s) return;
    caja.className = `ce-caja ce-consejo${s.bien ? " ce-bien" : ""}`;
    caja.innerHTML = `<b>${esc(s.titulo)}</b><p>${esc(s.texto)}</p>`;
    if (s.boton) {
      const b = document.createElement("button");
      b.className = "boton";
      b.textContent = "+  Agregar distancia";
      b.addEventListener("click", empezarDistancia);
      caja.appendChild(b);
    }
  }

  function empezarDistancia() {
    S.midiendo = true;
    S.primer = null;
    $("ce-agregar").textContent = "Toca el PRIMER punto en la imagen…";
    $("ce-agregar").classList.add("midiendo");
    $("ce-pie").textContent = "Toca el primer punto de la distancia que conoces (puedes acercar con + o la rueda del mouse).";
  }
  function terminarMedicion() {
    S.midiendo = false;
    S.primer = null;
    $("ce-agregar").textContent = "+  Agregar distancia";
    $("ce-agregar").classList.remove("midiendo");
  }

  // ---- toques y mouse sobre la imagen
  const pos = (e) => { const r = lienzo.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function tocar(p) {
    const G = geom(), v = aVideo(...p, G);
    if (!dentro(v)) return;
    if (S.midiendo) {
      if (!S.primer) {
        S.primer = v;
        $("ce-agregar").textContent = "Ahora toca el SEGUNDO punto…";
        $("ce-pie").textContent = "Toca el segundo punto.";
        pintar();
        return;
      }
      const [x1, y1] = S.primer;
      S.distancias.push({ p: [Math.round(x1 * 10) / 10, Math.round(y1 * 10) / 10, Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10], m: "" });
      terminarMedicion();
      recalcular();
      const entradas = $("ce-lista").querySelectorAll("input");
      entradas[entradas.length - 1]?.focus();
      $("ce-pie").textContent = "Escribe cuántos metros mide en la realidad.";
      return;
    }
    if (muestra && S.eleccion !== "Solo distancias") {
      const cam = muestra.camiones.find((k) => puntoEn(v, k.poli));
      if (cam) {
        cam.usado = !cam.usado;
        cam.motivo = cam.usado ? "" : "quitado por ti";
        recalcular();
      }
    }
  }
  function puntoEn([x, y], pts) {
    let d = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) d = !d;
    }
    return d;
  }
  function acercar(f, px, py) {
    const G = geom(), [vx, vy] = aVideo(px ?? G.Wc / 2, py ?? G.Hc / 2, G);
    const nuevo = Math.min(Math.max(S.vista.zoom * f, 1), 8);
    const e0 = G.e / S.vista.zoom, e = e0 * nuevo;
    S.vista.zoom = nuevo;
    S.vista.cx = vx - ((px ?? G.Wc / 2) - G.Wc / 2) / e;
    S.vista.cy = vy - ((py ?? G.Hc / 2) - G.Hc / 2) / e;
    pintar();
  }
  function textoCursor(p) {
    const G = geom(), v = aVideo(...p, G);
    S.cursor = dentro(v) ? v : null;
    if (!S.cursor) return;
    let txt = `Píxel (${Math.round(v[0])}, ${Math.round(v[1])})`;
    if (R?.geo) {
      const [x, y] = R.geo.aPlano(...v);
      txt += `  →  X ${f1(x)} m   Y ${f1(y)} m`;
      if (S.primer) txt += `   (distancia ${f1(hipot(v[0] - S.primer[0], v[1] - S.primer[1]) * R.escala)} m)`;
    }
    $("ce-pie").textContent = txt;
  }
  lienzo.onpointerdown = (e) => {
    lienzo.setPointerCapture(e.pointerId);
    S.punteros.set(e.pointerId, pos(e));
    if (S.punteros.size === 2) {
      const [a, b] = [...S.punteros.values()];
      S.gesto = { tipo: "pellizco", d: hipot(a[0] - b[0], a[1] - b[1]), zoom: S.vista.zoom };
    } else {
      S.gesto = { tipo: "toque", p: pos(e), cx: S.vista.cx, cy: S.vista.cy, movido: false };
    }
  };
  lienzo.onpointermove = (e) => {
    const p = pos(e);
    if (S.punteros.has(e.pointerId)) S.punteros.set(e.pointerId, p);
    if (S.gesto?.tipo === "pellizco" && S.punteros.size === 2) {
      const [a, b] = [...S.punteros.values()];
      const d = hipot(a[0] - b[0], a[1] - b[1]);
      acercar((S.gesto.zoom * d / S.gesto.d) / S.vista.zoom, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      return;
    }
    if (S.gesto?.tipo === "toque") {
      const dx = p[0] - S.gesto.p[0], dy = p[1] - S.gesto.p[1];
      if (S.gesto.movido || Math.abs(dx) + Math.abs(dy) > 6) {
        S.gesto.movido = true;
        if (S.vista.zoom > 1) {
          const G = geom();
          S.vista.cx = S.gesto.cx - dx / G.e;
          S.vista.cy = S.gesto.cy - dy / G.e;
          pintar();
          return;
        }
      }
    }
    textoCursor(p);
    if (S.primer) pintar();
  };
  const soltar = (e) => {
    const g0 = S.gesto;
    S.punteros.delete(e.pointerId);
    if (S.punteros.size === 0) {
      S.gesto = null;
      if (g0?.tipo === "toque" && !g0.movido) tocar(pos(e));
    }
  };
  lienzo.onpointerup = soltar;
  lienzo.onpointercancel = (e) => { S.punteros.delete(e.pointerId); S.gesto = null; };
  lienzo.onwheel = (e) => { e.preventDefault(); const p = pos(e); acercar(e.deltaY < 0 ? 1.25 : 0.8, p[0], p[1]); };

  // ---- botones
  document.querySelectorAll("#ce-eleccion button").forEach((b) => (b.onclick = () => {
    S.eleccion = b.dataset.v;
    if (S.eleccion === "Solo camión") terminarMedicion();
    recalcular();
  }));
  $("ce-largo").oninput = $("ce-ancho").oninput = programar;
  $("ce-agregar").onclick = () => (S.midiendo ? (terminarMedicion(), pintar()) : empezarDistancia());
  $("ce-mas").onclick = () => acercar(1.5);
  $("ce-menos").onclick = () => acercar(1 / 1.5);
  $("ce-zoom").onclick = () => { S.vista.zoom = 1; pintar(); };
  $("ce-original").hidden = !ctx.cambiada;
  $("ce-original").onclick = () => { cerrar(); ctx.alAplicar(base.georef, true); };
  $("ce-cancelar").onclick = () => cerrar();
  $("ce-aplicar").onclick = async () => {
    if (!R?.geo) return;
    const a = imp?.alerta;
    const geo = R.geo;
    if (a) {
      const detalle = a.esperado
        ? `Con esta calibración los camiones medirían ${Math.round(a.largo)} m (lo esperado es ≈ ${g(a.esperado)} m), así que las distancias y velocidades saldrían ${f1(a.factor)} veces ${a.factor > 1 ? "mayores" : "menores"} de lo real.`
        : `El largo del camión escrito (${g(a.largo)} m) no es común en minería (8–16 m).`;
      dlg.close();
      const si = await ctx.confirmar("¿Aplicar esta calibración?", `${detalle} Si estás seguro de tus datos, puedes aplicarla igual.`, "Aplicar igual", "Revisar");
      if (!si) { dlg.showModal(); requestAnimationFrame(pintar); return; }
      geo.info.revisar = a.esperado ? `los camiones medirían ${Math.round(a.largo)} m` : `largo del camión de ${g(a.largo)} m`;
    }
    cerrar();
    ctx.alAplicar(geo, false);
  };
  const alCambiarTamano = () => pintar();
  function cerrar() {
    window.removeEventListener("resize", alCambiarTamano);
    if (dlg.open) dlg.close();
  }
  window.addEventListener("resize", alCambiarTamano);
  dlg.oncancel = () => window.removeEventListener("resize", alCambiarTamano);
  terminarMedicion();
  $("ce-pie").textContent = "El (0; 0) es la esquina inferior izquierda. X hacia la derecha, Y hacia arriba.";
  dlg.showModal();
  recalcular();
  requestAnimationFrame(pintar);
}
