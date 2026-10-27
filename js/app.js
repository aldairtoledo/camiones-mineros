// Deteccion de Camiones Mineros - pagina web (modo demostracion).
// Reproduce el video ya analizado en la laptop y dibuja encima, sincronizados, las cajas,
// los numeros, las velocidades, las zonas, los avisos y los conteos. Los botones y su
// comportamiento copian a la app de escritorio (app.py).
import { Georreferencia, pasoGrilla } from "./georef.js";
import { recalcular, combinarAvisos, puntoEnPoligono, redondearPar, area, g } from "./recalculo.js";
import { ROLES } from "./resultados.js";
import { mostrarResultados, redimensionarResultados, elegirTabla, elegirCorte } from "./vista_resultados.js";

// ---------------------------------------------------------------- constantes (de app.py)
const COLOR_ZONA = { acumulativa: "#FF8000", dinamica: "#FF00FF" };
const NOMBRE_ZONA = { acumulativa: "Acumulativa", dinamica: "Dinámica" };
const DESC_ZONA = { acumulativa: "pasadas", dinamica: "dentro" };
const DESC_TIPO = { acumulativa: "Cuenta cuántos camiones pasan.", dinamica: "Muestra cuántos camiones hay dentro." };
const AYUDA_INICIAL = "Elige el tipo de zona y luego una forma para dibujar sobre el video.";
const AYUDA_FORMA = {
  "Rectángulo": "Mantén presionado el clic y arrastra sobre el video.",
  "Polígono": "Haz clic en cada esquina. Para terminar: doble clic o clic en el primer punto. Clic derecho borra el último punto.",
  "Círculo": "Haz clic en el centro y arrastra para darle tamaño.",
  "Libre": "Mantén presionado el clic y dibuja el contorno como con un lápiz. Al soltar se cierra.",
};
const ESTILO_AVISO = { info: ["#4DA3FF", "#1C2738"], aviso: ["#F2A900", "#2E2818"], alerta: ["#FF5C5C", "#3A1E22"] };
const SEGUNDOS_AVISO = 8;
const C = { acento: "#F2A900", info: "#4DA3FF", ok: "#4CD964", error: "#FF6B6B", suave: "#9AA3AE", texto: "#E8EAED",
            fondo: "#12151A", panel: "#1A1E25", caja: "#00FFFF" };
const ZOOM_MAX = 8;

const $ = (id) => document.getElementById(id);
const video = $("video"), capa = $("capa"), ctx = capa.getContext("2d");
const linea = $("linea"), lctx = linea.getContext("2d");

// ---------------------------------------------------------------- estado
const E = {
  demo: null, base: "", catalogo: [], georef: null,
  zonas: [], limiteGeneral: null, original: "", res: null, avisos: [], cambiado: false,
  iniciado: false, vivo: 0, tReloj: performance.now(),
  tipo: "acumulativa", forma: null, dibujo: null,
  velocidades: false, regla: false, puntosRegla: [], grilla: false, conteo: true,
  vista: { zoom: 1, cx: 400, cy: 300 }, rect: { x: 0, y: 0, w: 1, h: 1 }, dpr: 1,
  mouse: null, fichaFija: null, zonaResaltada: null, zonaHover: null,
  ranuras: [], tAvisos: 0, idxConteo: -1, punteros: new Map(), gesto: null,
};

// ---------------------------------------------------------------- utilidades
const hms = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const horaCorta = (s) => { const t = hms(s); return t.startsWith("0:") ? t.slice(2) : t; };
const miles = (v, dec = 0) => {
  const [e, d] = Math.abs(v).toFixed(dec).split(".");
  return (v < 0 ? "-" : "") + e.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (d ? "." + d : "");
};
const numero = (texto) => {
  let t = (texto || "").trim().replace(/[\s ]/g, "");
  if ((t.match(/,/g) || []).length === 1 && !t.includes(".")) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  const v = parseFloat(t);
  return Number.isFinite(v) && /^-?\d*\.?\d+$/.test(t) ? v : null;
};
const nombreZona = (z) => (E.zonas[z]?.nombre || "").trim() || `Zona ${z + 1}`;
const estrecho = () => window.matchMedia("(max-width: 900px)").matches;

function estado(texto, color = C.suave) {
  $("t-estado").textContent = texto;
  $("t-estado").style.color = color;
}

let tToast = null;
function toast(texto, ms = 4200) {
  const t = $("toast");
  t.textContent = texto;
  t.hidden = false;
  clearTimeout(tToast);
  tToast = setTimeout(() => (t.hidden = true), ms);
}

function confirmar(titulo, texto, si = "Aceptar", no = "Cancelar") {
  // Como en la app: el boton resaltado (Enter) es el que NO hace el cambio.
  return new Promise((ok) => {
    const d = $("dlg-confirmar");
    $("conf-titulo").textContent = titulo;
    $("conf-texto").textContent = texto;
    $("conf-si").textContent = si;
    $("conf-no").textContent = no;
    const cerrar = (v) => { d.close(); ok(v); };
    $("conf-si").onclick = () => cerrar(true);
    $("conf-no").onclick = () => cerrar(false);
    d.oncancel = (e) => { e.preventDefault(); cerrar(false); };
    d.showModal();
    $("conf-no").focus();
  });
}

document.querySelectorAll("[data-cerrar]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// ---------------------------------------------------------------- carga de datos
async function cargar() {
  try {
    const r = await fetch("datos/catalogo.json", { cache: "no-cache" });
    if (!r.ok) throw new Error();
    E.catalogo = (await r.json()).videos || [];
  } catch {
    $("mensaje-video").innerHTML = "No se encontraron datos de demostración.<br>Corre <b>exportar_demo.py</b> en la laptop " +
      "y abre esta página con un servidor (ver instrucciones).";
    $("t-video").textContent = "Sin datos";
    return;
  }
  if (!E.catalogo.length) {
    $("mensaje-video").textContent = "Todavía no hay videos de demostración. Corre exportar_demo.py en la laptop.";
    return;
  }
  const pedido = new URLSearchParams(location.search).get("demo");
  const elegido = E.catalogo.find((v) => v.nombre === pedido) || E.catalogo[0];
  E.base = `datos/${elegido.nombre}/`;
  $("mensaje-video").textContent = "Cargando los datos del análisis…";
  let demo;
  try {
    demo = await (await fetch(E.base + "demo.json")).json();
  } catch {
    $("mensaje-video").textContent = "No se pudieron leer los datos de este video (demo.json).";
    return;
  }
  E.demo = demo;
  E.georef = Georreferencia.desdeDict(demo.calibracion);
  E.zonas = zonasDelAnalisis();
  E.limiteGeneral = demo.limite_general;
  E.original = firma();
  E.vista = { zoom: 1, cx: demo.trabajo[0] / 2, cy: demo.trabajo[1] / 2 };
  document.title = `${demo.video} · Detección de Camiones Mineros`;
  $("t-video").textContent = demo.video;
  $("e-limite").value = E.limiteGeneral ? g(E.limiteGeneral) : "";
  $("t-pie").textContent = `Modo demostración · analizado el ${demo.generado} en modo ${demo.modo} (${demo.dispositivo}).`;
  document.querySelectorAll("#seg-velocidad button").forEach((b) => {
    const activo = b.dataset.modo === demo.modo;
    b.classList.toggle("activo", activo);
    b.setAttribute("aria-checked", String(activo));
  });
  actualizarCalibracion();
  recalcularTodo();
  video.src = E.base + demo.archivo_video;
  video.addEventListener("loadeddata", () => {
    $("mensaje-video").hidden = true;
    estado("Demostración lista. Presiona Iniciar para ver el análisis.", C.ok);
  }, { once: true });
  video.addEventListener("error", () => {
    $("mensaje-video").hidden = false;
    $("mensaje-video").textContent = `Tu navegador no pudo reproducir el video (formato ${demo.codec}). ` +
      "Prueba con otro navegador o pide convertirlo a H.264.";
  });
  video.addEventListener("ended", () => { if (enDirecto()) estado("Video terminado.", C.ok); });
  actualizarBotones();
  diseno();
}

// ---------------------------------------------------------------- recalculo (zonas y limites)
const zonasDelAnalisis = () => E.demo.zonas.map((z) => ({ puntos: z.puntos.map((p) => [...p]), tipo: z.tipo,
  nombre: z.nombre || "", limite: z.limite, rol: ROLES[z.rol] ? z.rol : "" }));
const firma = () => JSON.stringify({ z: E.zonas, l: E.limiteGeneral || null });

function recalcularTodo() {
  const d = E.demo;
  if (!d) return;
  E.cambiado = firma() !== E.original;
  E.res = recalcular(d, { zonas: E.zonas, limiteGeneral: E.limiteGeneral, georef: E.georef });
  E.avisos = combinarAvisos(d, { zonas: E.zonas }, E.res, E.cambiado);
  $("b-zonas-originales").hidden = !E.cambiado;
  construirConteo();
  E.idxConteo = -1;
}

// ---------------------------------------------------------------- tiempo y "directo"
// Como en la app: el "directo" es hasta donde llego el analisis. Si retrocedes, el analisis
// sigue avanzando y el boton "Volver al directo" te lleva de nuevo hasta ahi.
const duracion = () => E.demo ? E.demo.duracion_s : 0;
const enDirecto = () => video.currentTime >= E.vivo - 0.3;
const reproduciendo = () => !video.paused && !video.ended;
const indice = (t) => Math.min(E.demo.cuadros.length - 1, Math.max(0, Math.floor(t * E.demo.fps + 1e-4)));

function actualizarVivo(dt) {
  if (!E.iniciado || !reproduciendo()) return;
  const t = video.currentTime;
  if (t >= E.vivo - 0.3) E.vivo = Math.max(E.vivo, t);
  else E.vivo = Math.min(duracion(), E.vivo + dt);
}

function irA(t) {
  if (!E.demo || !E.iniciado) return;
  t = Math.max(0, Math.min(t, E.vivo));
  video.currentTime = t;
  limpiarAvisos();
  E.tAvisos = t;
  if (t < E.vivo - 0.3) estado(`Viendo el segundo ${horaCorta(t)}. El análisis sigue en directo.`, C.acento);
}

function pausar() {
  if (!E.demo) return;
  if (!E.iniciado) {
    E.iniciado = true;
    video.currentTime = 0;
    E.tAvisos = 0;
    estado("Analizando el video…", C.ok);
    video.play().catch(() => {});
  } else if (video.ended) {
    irA(0);
    video.play().catch(() => {});
  } else if (reproduciendo()) {
    video.pause();
    estado("En pausa.", C.suave);
  } else {
    video.play().catch(() => {});
    estado(enDirecto() ? "Analizando el video…" : `Viendo el segundo ${horaCorta(video.currentTime)}.`,
           enDirecto() ? C.ok : C.acento);
  }
  actualizarBotones();
}

function reiniciar() {
  if (!E.demo) return;
  video.pause();
  video.currentTime = 0;
  E.iniciado = false;
  E.vivo = 0;
  limpiarAvisos();
  E.tAvisos = 0;
  estado("Listo para iniciar. Puedes modificar las zonas.", C.suave);
  actualizarBotones();
}

function actualizarBotones() {
  const hay = !!E.demo, geo = !!E.georef;
  const b = $("b-pausa");
  let texto = "▶  Iniciar";
  if (E.iniciado) texto = video.ended ? "↺  Ver de nuevo" : reproduciendo() ? "⏸  Pausar" : "▶  Continuar";
  if (b.textContent !== texto) b.textContent = texto;
  b.classList.toggle("pausado", !texto.startsWith("⏸"));
  b.disabled = !hay;
  $("b-atras10").disabled = $("b-atras5").disabled = !E.iniciado;
  $("b-adelante5").disabled = !E.iniciado || enDirecto();
  const d = $("b-directo"), atras = E.iniciado && !enDirecto();
  d.classList.toggle("atras", atras);
  const td = atras ? "⏩  Volver al directo" : "●  En directo";
  if (d.textContent !== td) d.textContent = td;
  for (const id of ["b-vel", "b-regla", "b-grilla"]) $(id).disabled = !geo;
  $("b-reiniciar").disabled = !E.iniciado;
  $("b-deshacer").disabled = $("b-borrar").disabled = !E.zonas.length;
  $("b-guardar-zonas").disabled = !E.zonas.length;
}

// ---------------------------------------------------------------- diseno y zoom
function diseno() {
  const m = $("marco");
  const W = m.clientWidth, H = m.clientHeight;
  if (!W || !H) return;                // la pestana de Monitoreo esta oculta (se ven los Resultados)
  E.dpr = window.devicePixelRatio || 1;
  capa.width = Math.round(W * E.dpr);
  capa.height = Math.round(H * E.dpr);
  const [rw, rh] = E.demo ? E.demo.resolucion : [16, 9];
  const prop = rw / rh;
  const bw = Math.min(W, H * prop), bh = bw / prop;
  E.rect = { x: (W - bw) / 2, y: (H - bh) / 2, w: bw, h: bh };
  const r = $("recorte");
  Object.assign(r.style, { left: `${E.rect.x}px`, top: `${E.rect.y}px`, width: `${bw}px`, height: `${bh}px` });
  video.style.width = `${bw}px`;
  video.style.height = `${bh}px`;
  dibujarLinea();
}

function geom() {
  // canvas = o + logico * e  (logico = cuadro de trabajo del motor, 800 x 600)
  const [AW, AH] = E.demo ? E.demo.trabajo : [800, 600];
  const v = E.vista, r = E.rect;
  const ex = r.w / AW * v.zoom, ey = r.h / AH * v.zoom;
  const mw = r.w / 2 / ex, mh = r.h / 2 / ey;
  if (!(ex > 0 && ey > 0)) return { ex: 0, ey: 0, ox: r.x, oy: r.y };
  v.cx = Math.min(Math.max(v.cx, mw), AW - mw);
  v.cy = Math.min(Math.max(v.cy, mh), AH - mh);
  return { ex, ey, ox: r.x + r.w / 2 - v.cx * ex, oy: r.y + r.h / 2 - v.cy * ey };
}

function aplicarZoom() {
  const { ox, oy } = geom();
  video.style.transform = `translate(${ox - E.rect.x}px, ${oy - E.rect.y}px) scale(${E.vista.zoom})`;
  const con = E.vista.zoom > 1.001;
  $("b-zoom").hidden = !con;
  if (con) $("b-zoom").textContent = `Zoom ${Math.round(E.vista.zoom * 100)} %  ✕`;
}

function acercar(factor, x, y) {
  const r = E.rect;
  if (x == null) { x = r.x + r.w / 2; y = r.y + r.h / 2; }
  const { ex, ey, ox, oy } = geom();
  const lx = (x - ox) / ex, ly = (y - oy) / ey;
  const nuevo = Math.min(Math.max(E.vista.zoom * factor, 1), ZOOM_MAX);
  if (Math.abs(nuevo - E.vista.zoom) < 1e-6) return;
  const [AW, AH] = E.demo.trabajo;
  E.vista.zoom = nuevo;
  const nex = r.w / AW * nuevo, ney = r.h / AH * nuevo;
  E.vista.cx = lx - (x - (r.x + r.w / 2)) / nex;          // el punto bajo el mouse no se mueve
  E.vista.cy = ly - (y - (r.y + r.h / 2)) / ney;
  aplicarZoom();
}

function restablecerZoom() {
  E.vista.zoom = 1;
  aplicarZoom();
}

const aCanvas = (x, y, G = geom()) => [G.ox + x * G.ex, G.oy + y * G.ey];
function aTrabajo(px, py, G = geom()) {
  const [AW, AH] = E.demo.trabajo;
  return [Math.min(Math.max((px - G.ox) / G.ex, 0), AW - 1), Math.min(Math.max((py - G.oy) / G.ey, 0), AH - 1)];
}
const aOriginal = (x, y) => [x * E.demo.resolucion[0] / E.demo.trabajo[0], y * E.demo.resolucion[1] / E.demo.trabajo[1]];

// ---------------------------------------------------------------- dibujo sobre el video
function linea2(a, b, color, ancho = 1, guion = []) {
  ctx.beginPath();
  ctx.setLineDash(guion);
  ctx.strokeStyle = color;
  ctx.lineWidth = ancho;
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function trazar(pts, cerrar = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (cerrar) ctx.closePath();
}

function etiqueta(texto, x, y, fondo, color, borde = null, letra = "600 11px IBM Plex Sans, sans-serif") {
  ctx.font = letra;
  const w = ctx.measureText(texto).width + 10, h = 17;
  ctx.fillStyle = fondo;
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
  if (borde) { ctx.strokeStyle = borde; ctx.lineWidth = 1; ctx.strokeRect(x - w / 2 + .5, y - h / 2 + .5, w - 1, h - 1); }
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(texto, x, y + 0.5);
}

function dibujar(idx) {
  const W = capa.width / E.dpr, H = capa.height / E.dpr;
  ctx.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!E.demo) return;
  const G = geom(), r = E.rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  if (E.grilla && E.georef) dibujarGrilla(G);
  dibujarZonas(G);
  const camiones = E.iniciado ? camionesEn(idx, G) : [];
  dibujarCamiones(camiones);
  if (E.velocidades && E.georef) dibujarVelocidades(camiones, idx);
  dibujarTemporal(G);
  dibujarRegla(G);
  ctx.restore();
  actualizarFicha(camiones, idx);
}

function camionesEn(idx, G) {
  const filas = E.demo.cuadros[idx][3];
  return filas.map((f, k) => {
    const [pid, x, y, w, h, kmh, , poli] = f;
    const [x1, y1] = aCanvas(x, y, G), [x2, y2] = aCanvas(x + w, y + h, G);
    let pts = null;
    if (poli) {
      const cx = x + w / 2, cy = y + h / 2;
      pts = [0, 2, 4, 6].map((i) => aCanvas(poli[i] + cx, poli[i + 1] + cy, G));
    }
    return { k, pid, caja: [x, y, w, h], kmh, x1, y1, x2, y2, pts };
  });
}

function dibujarZonas(G) {
  E.zonas.forEach((z, i) => {
    const pts = z.puntos.map(([x, y]) => aCanvas(x, y, G));
    const color = COLOR_ZONA[z.tipo];
    const resaltada = i === E.zonaResaltada || i === E.zonaHover;
    trazar(pts);
    if (resaltada) {
      ctx.fillStyle = color + "46";
      ctx.fill();
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
    } else {
      ctx.setLineDash([10, 6]);
      ctx.lineWidth = 2;
    }
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
    if (resaltada) {
      const xmin = Math.min(...pts.map((p) => p[0])), ymin = Math.min(...pts.map((p) => p[1]));
      ctx.font = "600 12px IBM Plex Sans, sans-serif";
      const w = ctx.measureText(nombreZona(i)).width + 12;
      ctx.fillStyle = color;
      ctx.fillRect(xmin, ymin - 20, w, 18);
      ctx.fillStyle = "#14171C";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(nombreZona(i), xmin + 6, ymin - 10.5);
    }
  });
}

function dibujarCamiones(camiones) {
  // Igual que deteccion_camiones.dibujar_camiones: caja fina color cian y el numero en una
  // etiqueta que busca un lugar libre para no tapar otra.
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.caja;
  for (const c of camiones) {
    if (c.pts) trazar(c.pts);
    else { ctx.beginPath(); ctx.rect(c.x1, c.y1, c.x2 - c.x1, c.y2 - c.y1); }
    ctx.stroke();
  }
  const ocupadas = [];
  ctx.font = "600 11px IBM Plex Sans, sans-serif";
  const r = E.rect;
  for (const c of [...camiones].sort((a, b) => a.y1 - b.y1)) {
    const texto = String(c.pid);
    const ew = ctx.measureText(texto).width + 8, eh = 15;
    const { x1, y1, x2, y2 } = c;
    const opciones = [[x1, y1 - eh], [x2 - ew, y1 - eh], [x1, y2], [x2 - ew, y2], [x1 - ew, y1], [x2, y1], [x1 + 1, y1 + 1]];
    let elegido = null;
    for (let [ex, ey] of opciones) {
      ex = Math.min(Math.max(r.x, ex), r.x + r.w - ew);
      ey = Math.min(Math.max(r.y, ey), r.y + r.h - eh);
      const caja = [ex, ey, ex + ew, ey + eh];
      if (!ocupadas.some((o) => caja[0] < o[2] && o[0] < caja[2] && caja[1] < o[3] && o[1] < caja[3])) { elegido = caja; break; }
    }
    if (!elegido) {
      const ex = Math.min(Math.max(r.x, x1), r.x + r.w - ew), ey = Math.min(Math.max(r.y, y1 - eh), r.y + r.h - eh);
      elegido = [ex, ey, ex + ew, ey + eh];
    }
    ocupadas.push(elegido);
    c.etiqueta = elegido;
    ctx.fillStyle = C.caja;
    ctx.fillRect(elegido[0], elegido[1], ew, eh);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(texto, elegido[0] + ew / 2, elegido[1] + eh / 2 + 0.5);
  }
}

function limiteDe(idx, k) { return E.res?.limites[idx]?.[k] || [null, null]; }

function dibujarVelocidades(camiones, idx) {
  for (const c of camiones) {
    const texto = c.kmh != null ? `${c.kmh.toFixed(0)} km/h` : "— km/h";       // recien aparecido
    const [lim] = limiteDe(idx, c.k);
    const exceso = lim && c.kmh != null && c.kmh > lim + 1;
    const color = exceso ? C.error : c.kmh != null && c.kmh >= 1 ? C.ok : C.suave;
    etiqueta(texto, (c.x1 + c.x2) / 2, c.y2 + 11, C.fondo, color, color);
  }
}

function dibujarTemporal(G) {
  const d = E.dibujo;
  if (!d || !d.puntos.length) return;
  const color = COLOR_ZONA[E.tipo];
  const pts = d.puntos.map(([x, y]) => aCanvas(x, y, G));
  if (d.forma === "Rectángulo" && pts.length === 2) {
    const [[ax, ay], [bx, by]] = pts;
    trazar([[ax, ay], [bx, ay], [bx, by], [ax, by]]);
  } else if (d.forma === "Círculo" && pts.length === 2) {
    const [[ax, ay], [bx, by]] = pts;
    ctx.beginPath();
    ctx.arc(ax, ay, Math.hypot(bx - ax, by - ay), 0, Math.PI * 2);
  } else {
    const extra = d.forma === "Polígono" && d.cursor ? [aCanvas(...d.cursor, G)] : [];
    trazar([...pts, ...extra], false);
  }
  ctx.setLineDash(d.forma === "Libre" ? [] : [6, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  if (d.forma === "Polígono") {
    pts.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? C.fondo : color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

function metrosEntre(a, b) {
  const [e1, n1] = E.georef.aCoordenadas(...aOriginal(...a));
  const [e2, n2] = E.georef.aCoordenadas(...aOriginal(...b));
  return Math.hypot(e2 - e1, n2 - n1);
}

function dibujarRegla(G) {
  if (!E.regla || !E.puntosRegla.length || !E.georef) return;
  const pts = E.puntosRegla.map((p) => aCanvas(...p, G));
  const puntosTrabajo = [...E.puntosRegla];
  if (pts.length === 1 && E.mouse) { pts.push(E.mouse); puntosTrabajo.push(aTrabajo(...E.mouse, G)); }
  if (pts.length === 2) {
    linea2(pts[0], pts[1], C.fondo, 5);
    linea2(pts[0], pts[1], "#FFD54F", 2);
    const m = metrosEntre(puntosTrabajo[0], puntosTrabajo[1]);
    etiqueta(`${miles(m, 1)} m`, (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 - 15, "#FFD54F", C.fondo,
             null, "600 13px IBM Plex Sans, sans-serif");
  }
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#FFD54F";
    ctx.fill();
    ctx.strokeStyle = C.fondo;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function dibujarGrilla(G) {
  // Grilla en metros (app.py _dibujar_grilla): lineas finas y numeros en los bordes.
  const geo = E.georef, r = E.rect;
  const [x0, y0] = aTrabajo(r.x, r.y, G), [x1, y1] = aTrabajo(r.x + r.w, r.y + r.h, G);
  const esquinas = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => geo.aCoordenadas(...aOriginal(x, y)));
  const emin = Math.min(...esquinas.map((p) => p[0])), emax = Math.max(...esquinas.map((p) => p[0]));
  const nmin = Math.min(...esquinas.map((p) => p[1])), nmax = Math.max(...esquinas.map((p) => p[1]));
  const paso = pasoGrilla(Math.max(emax - emin, nmax - nmin), 10);
  const [e0, n0] = geo.esPlano() ? geo.origenPlano() : [0, 0];
  const fx = E.demo.trabajo[0] / E.demo.resolucion[0], fy = E.demo.trabajo[1] / E.demo.resolucion[1];
  const pc = (e, n) => { const [px, py] = geo.aPixel(e, n); return aCanvas(px * fx, py * fy, G); };
  const texto = (v) => geo.esPlano() ? `${g(Math.round(v * 100) / 100)} m` : miles(v);
  const usadas = [];
  const rotulo = (txt, x, y, color) => {
    ctx.font = "600 11px IBM Plex Sans, sans-serif";
    const w = ctx.measureText(txt).width + 10;
    x = Math.min(Math.max(x, r.x + w / 2 + 2), r.x + r.w - w / 2 - 2);
    y = Math.min(Math.max(y, r.y + 10), r.y + r.h - 10);
    if (usadas.some(([ux, uy]) => Math.abs(x - ux) < w && Math.abs(y - uy) < 18)) return;
    usadas.push([x, y]);
    etiqueta(txt, x, y, C.fondo, color);
  };
  const lineas = [];
  for (let k = Math.ceil((emin - e0) / paso), tope = k + 400; e0 + k * paso <= emax && k < tope; k++) {
    const v = e0 + k * paso;
    lineas.push({ a: pc(v, nmin), b: pc(v, nmax), eje: Math.abs(v - e0) < 1e-9 && geo.esPlano(),
                  txt: texto(geo.esPlano() ? v - e0 : v), borde: "abajo" });
  }
  for (let k = Math.ceil((nmin - n0) / paso), tope = k + 400; n0 + k * paso <= nmax && k < tope; k++) {
    const v = n0 + k * paso;
    lineas.push({ a: pc(emin, v), b: pc(emax, v), eje: Math.abs(v - n0) < 1e-9 && geo.esPlano(),
                  txt: texto(geo.esPlano() ? v - n0 : v), borde: "izquierda" });
  }
  for (const l of lineas) linea2(l.a, l.b, l.eje ? C.acento : "rgba(221,227,234,.75)", l.eje ? 2 : 1, l.eje ? [] : [2, 4]);
  for (const l of lineas) {
    if (l.borde === "abajo") { const p = l.a[1] > l.b[1] ? l.a : l.b; rotulo(l.txt, p[0], r.y + r.h - 10, l.eje ? C.acento : "#DDE3EA"); }
    else { const p = l.a[0] < l.b[0] ? l.a : l.b; rotulo(l.txt, r.x + 24, p[1], l.eje ? C.acento : "#DDE3EA"); }
  }
}

// ---------------------------------------------------------------- ficha del camion
function camionBajo(camiones, x, y) {
  return camiones.find((c) => c.x1 - 4 <= x && x <= c.x2 + 4 && c.y1 - 4 <= y && y <= c.y2 + 4);
}

function actualizarFicha(camiones, idx) {
  const f = $("ficha");
  let c = null, mx, my;
  if (E.fichaFija != null) {
    c = camiones.find((k) => k.pid === E.fichaFija);
    if (c) { mx = c.x2; my = c.y1; }
  } else if (E.mouse && !E.regla && !E.forma) {
    [mx, my] = E.mouse;
    c = camionBajo(camiones, mx, my);
  }
  if (!c) { if (!f.hidden) f.hidden = true; return; }
  const lineas = [`<strong>Camión ${c.pid}</strong>`];
  if (E.georef) {
    lineas.push(c.kmh != null ? `Velocidad: ${c.kmh.toFixed(0)} km/h` : "Velocidad: midiendo…");
    const [lim, zona] = limiteDe(idx, c.k);
    if (lim) {
      const exceso = c.kmh != null && c.kmh > lim + 1;
      lineas.push(`Límite: ${g(lim)} km/h${zona ? ` (${zona})` : ""}${exceso ? ' <span class="exceso">⚠ EXCESO</span>' : ""}`);
    }
    const rec = E.res?.recorrido[idx]?.[c.k];
    if (rec != null) lineas.push(`Recorrido: ${miles(rec)} m`);
    const [x, y, w, h] = c.caja;
    const [px, py] = aOriginal(x + w / 2, y + h / 2);
    const [a, b] = E.georef.esPlano() ? E.georef.aPlano(px, py) : E.georef.aCoordenadas(px, py);
    lineas.push(E.georef.esPlano() ? `X ${miles(a, 1)} m &nbsp; Y ${miles(b, 1)} m` : `E ${miles(a, 1)} &nbsp; N ${miles(b, 1)}`);
  } else {
    lineas.push("Calibra el video para ver km/h y metros");
  }
  const html = lineas.join("<br>");
  if (f.innerHTML !== html) f.innerHTML = html;
  f.hidden = false;
  const W = capa.width / E.dpr, H = capa.height / E.dpr;
  const fw = f.offsetWidth, fh = f.offsetHeight;
  let x0, y0;
  if (E.fichaFija != null) {
    // Pantalla tactil: la ficha va encima del camion tocado (o debajo si no hay espacio).
    x0 = Math.min(Math.max(4, (c.x1 + c.x2) / 2 - fw / 2), W - fw - 4);
    y0 = c.y1 - fh - 22 >= 4 ? c.y1 - fh - 22 : Math.min(H - fh - 4, c.y2 + 24);
  } else {
    x0 = mx + 16 + fw < W ? mx + 16 : mx - 16 - fw;
    y0 = Math.max(4, Math.min(my - fh - 8, H - fh - 4));
  }
  f.style.left = `${Math.max(4, x0)}px`;
  f.style.top = `${y0}px`;
}

// ---------------------------------------------------------------- panel de conteo
function construirConteo() {
  const cont = $("tarjetas-conteo");
  cont.innerHTML = "";
  $("t-sin-zonas").hidden = E.zonas.length > 0;
  E.zonas.forEach((z, i) => {
    const t = document.createElement("div");
    t.className = "tarjeta-conteo";
    t.style.setProperty("--color-zona", COLOR_ZONA[z.tipo]);
    t.innerHTML = `<span class="franja"></span>
      <div class="textos">
        <button class="nombre" title="Cambiar nombre, límite o papel de la zona"><span></span><span class="lapiz" aria-hidden="true">✎</span></button>
        <div class="tipo">${NOMBRE_ZONA[z.tipo]} · ${DESC_ZONA[z.tipo]}${z.rol && ROLES[z.rol].toLowerCase() !== nombreZona(i).toLowerCase() ? ` · <b>${ROLES[z.rol]}</b>` : ""}</div>
        ${z.limite ? `<div class="maximo">Máx. ${g(z.limite)} km/h</div>` : ""}
      </div>
      <span class="valor">0</span>`;
    t.querySelector(".nombre span").textContent = nombreZona(i);
    t.querySelector(".nombre").addEventListener("click", () => editarZona(i));
    t.addEventListener("mouseenter", () => { E.zonaResaltada = i; t.classList.add("resaltada"); });
    t.addEventListener("mouseleave", () => { E.zonaResaltada = null; t.classList.remove("resaltada"); });
    cont.appendChild(t);
  });
  actualizarBotones();
}

function actualizarConteo(idx) {
  if (!E.res || idx === E.idxConteo) return;
  E.idxConteo = idx;
  const valores = $("tarjetas-conteo").querySelectorAll(".valor");
  const mostrar = E.iniciado;
  valores.forEach((el, z) => {
    const v = String(mostrar ? E.res.conteos[idx * E.res.Z + z] : 0);
    if (el.textContent !== v) el.textContent = v;
  });
  const activos = String(mostrar ? E.demo.cuadros[idx][2] : 0);
  if ($("t-activos").textContent !== activos) $("t-activos").textContent = activos;
}

// ---------------------------------------------------------------- avisos
const ICONOS = {
  destino: '<path d="M12 5a4.5 4.5 0 0 0-4.5 4.5c0 3.4 4.5 8.5 4.5 8.5s4.5-5.1 4.5-8.5A4.5 4.5 0 0 0 12 5zm0 6.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4z" fill="C"/>',
  cercano: '<path d="M5 9h12m-3-3 3 3-3 3M19 15H7m3-3-3 3 3 3" stroke="C" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  alto: '<rect x="8.5" y="7" width="2.6" height="10" rx=".6" fill="C"/><rect x="12.9" y="7" width="2.6" height="10" rx=".6" fill="C"/>',
  marcha: '<path d="M9.5 7v10l8-5z" fill="C"/>',
  zona: '<rect x="10.5" y="7" width="7" height="10" rx="1.4" stroke="C" stroke-width="1.8" fill="none"/><path d="M5 12h9m-2.5-2.5L14 12l-2.5 2.5" stroke="C" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  salida: '<path d="M7 6v12M9.5 12h9m-3-3 3 3-3 3" stroke="C" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  ingreso: '<path d="M7 6v12M18.5 12h-9m3-3-3 3 3 3" stroke="C" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  velocidad: '<path d="M6 16a6 6 0 1 1 12 0" stroke="C" stroke-width="1.8" fill="none"/><path d="M12 15.5l3.6-4.4" stroke="C" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15.5" r="1.4" fill="C"/>',
  curva: '<path d="M7 18v-4a6 6 0 0 1 6-6h4m-3-3 3 3-3 3" stroke="C" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  regreso: '<path d="M8 17v-6a4 4 0 0 1 8 0v6M5.8 14.6 8 17l2.2-2.4" stroke="C" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  alerta: '<path d="M12 5.5 19 18H5z" fill="C"/><rect x="11.2" y="10" width="1.6" height="4" rx=".5" fill="#141414"/><circle cx="12" cy="15.8" r=".9" fill="#141414"/>',
};
const ICONO_AVISO = { ACERCAMIENTO: "destino", PASO_CERCANO: "cercano", DETENIDO: "alto", ARRANQUE: "marcha", CURVA: "curva",
  REGRESO: "regreso", ENTRADA_ZONA: "zona", SALIDA_PANTALLA: "salida", ENTRADA_PANTALLA: "ingreso", RETROCESO: "alerta",
  GIRO_180: "alerta", EXCESO_VELOCIDAD: "velocidad" };
const svgIcono = (tipo, color) => `<svg class="icono" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="${color}" fill-opacity=".24"/>${(ICONOS[ICONO_AVISO[tipo]] || ICONOS.destino).replaceAll('"C"', `"${color}"`)}</svg>`;

function crearRanuras() {
  const cont = $("avisos");
  // Computadora: 2 filas x 4 columnas, como en la app. Celular: 4 avisos (1 o 2 columnas).
  const columnas = window.matchMedia("(max-width: 560px)").matches ? 1
    : window.matchMedia("(max-width: 700px)").matches ? 2 : 4;
  const total = columnas === 4 ? 8 : 4;
  if (E.ranuras.length === total && E.columnas === columnas) return;
  E.columnas = columnas;
  cont.style.setProperty("--columnas", columnas);
  cont.innerHTML = "";
  E.ranuras = [];
  for (let n = 0; n < total; n++) {
    const el = document.createElement("button");
    el.className = "aviso";
    el.tabIndex = -1;
    const r = { el, aviso: null, restante: 0, hover: false };
    el.addEventListener("mouseenter", () => (r.hover = true));
    el.addEventListener("mouseleave", () => (r.hover = false));
    el.addEventListener("click", () => { if (r.aviso) irA(Math.max(0, r.aviso.tiempo_s - 2)); });
    cont.appendChild(el);
    E.ranuras.push(r);
  }
}

function pintarRanura(r, aviso) {
  r.aviso = aviso;
  const el = r.el;
  if (!aviso) {
    el.className = "aviso";
    el.innerHTML = "";
    el.tabIndex = -1;
    el.removeAttribute("aria-label");
    return;
  }
  const [color, fondo] = ESTILO_AVISO[aviso.nivel] || ESTILO_AVISO.info;
  el.className = "aviso lleno";
  el.tabIndex = 0;
  el.style.setProperty("--color-aviso", color);
  el.style.setProperty("--fondo-aviso", fondo);
  el.innerHTML = `${svgIcono(aviso.tipo, color)}<span class="tit"></span><span class="det"></span><span class="hora">${horaCorta(aviso.tiempo_s)}</span>`;
  el.querySelector(".tit").textContent = aviso.titulo || aviso.mensaje || "";
  el.querySelector(".det").textContent = aviso.corto || aviso.detalle || "";
  el.title = aviso.detalle || "";
  el.setAttribute("aria-label", `${aviso.titulo}. ${aviso.detalle}. Clic para ver ese momento.`);
}

function mostrarAviso(a) {
  // Primer lugar libre; si no hay, reemplaza al que le queda menos tiempo (los demas no se mueven).
  let r = E.ranuras.find((x) => !x.aviso);
  if (!r) r = E.ranuras.reduce((m, x) => (x.restante < m.restante ? x : m));
  r.restante = SEGUNDOS_AVISO;
  pintarRanura(r, a);
}

function limpiarAvisos() { E.ranuras.forEach((r) => pintarRanura(r, null)); }

function revisarAvisos(dt) {
  const t = video.currentTime;
  const avanza = E.iniciado && reproduciendo();
  if (t < E.tAvisos - 0.5) { limpiarAvisos(); E.tAvisos = t; }
  if (avanza && t > E.tAvisos) {
    const nuevos = E.avisos.filter((a) => a.tiempo_s > E.tAvisos && a.tiempo_s <= t).slice(-E.ranuras.length);
    nuevos.forEach(mostrarAviso);
    E.tAvisos = t;
  }
  for (const r of E.ranuras) {
    if (!r.aviso) continue;
    if (avanza && !r.hover) r.restante -= dt;     // el tiempo solo corre si el video avanza
    if (r.restante <= 0) pintarRanura(r, null);
  }
}

// ---------------------------------------------------------------- linea de tiempo
function dibujarLinea() {
  const dpr = window.devicePixelRatio || 1;
  const W = linea.clientWidth, H = linea.clientHeight;
  if (linea.width !== Math.round(W * dpr)) { linea.width = Math.round(W * dpr); linea.height = Math.round(H * dpr); }
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lctx.clearRect(0, 0, W, H);
  const x0 = 7, x1 = W - 7, y = H - 8;
  const barra = (desde, hasta, color) => {
    lctx.beginPath();
    lctx.lineCap = "round";
    lctx.lineWidth = 8;
    lctx.strokeStyle = color;
    lctx.moveTo(desde, y);
    lctx.lineTo(hasta, y);
    lctx.stroke();
  };
  barra(x0, x1, "#222731");
  if (!E.demo) return;
  const px = (t) => x0 + (x1 - x0) * Math.min(Math.max(t / duracion(), 0), 1);
  if (E.vivo > 0) barra(x0, px(E.vivo), C.acento);
  lctx.lineCap = "butt";
  lctx.lineWidth = 2;
  for (const a of E.avisos) {
    if (a.tiempo_s > E.vivo + 0.05) continue;     // solo lo que ya se analizo, como en la app
    const xm = Math.round(px(a.tiempo_s)) + 0.5;
    lctx.strokeStyle = (ESTILO_AVISO[a.nivel] || ESTILO_AVISO.info)[0];
    lctx.beginPath();
    lctx.moveTo(xm, 2);
    lctx.lineTo(xm, y - 6);
    lctx.stroke();
  }
  if (E.iniciado && !enDirecto()) {
    const xr = px(video.currentTime);
    lctx.beginPath();
    lctx.arc(xr, y, 7, 0, Math.PI * 2);
    lctx.fillStyle = "#FFFFFF";
    lctx.fill();
    lctx.lineWidth = 2;
    lctx.strokeStyle = C.acento;
    lctx.stroke();
  }
}

function clicLinea(e) {
  if (!E.demo || !E.iniciado) return;
  const r = linea.getBoundingClientRect();
  const f = Math.min(Math.max((e.clientX - r.left - 7) / Math.max(r.width - 14, 1), 0), 1);
  irA(f * duracion());
}
linea.addEventListener("pointerdown", (e) => { linea.setPointerCapture(e.pointerId); clicLinea(e); });
linea.addEventListener("pointermove", (e) => { if (e.buttons) clicLinea(e); });

// ---------------------------------------------------------------- ciclo principal
function textosTiempo() {
  const t = $("t-tiempo");
  const total = hms(duracion());
  let texto, atras = false;
  if (!E.iniciado) texto = `0:00:00 / ${total}`;
  else if (enDirecto()) texto = `${hms(Math.min(video.currentTime, E.vivo))} / ${total}`;
  else {
    atras = true;
    texto = `${hms(video.currentTime)} / ${total}   ·   ${Math.max(0, Math.round(E.vivo - video.currentTime))} s detrás del directo`;
  }
  if (t.textContent !== texto) t.textContent = texto;
  t.classList.toggle("atras", atras);
}

function ciclo(ahora) {
  const dt = Math.min(0.25, (ahora - E.tReloj) / 1000);
  E.tReloj = ahora;
  if (E.demo) {
    actualizarVivo(dt);
    const idx = indice(video.currentTime);
    dibujar(idx);
    actualizarConteo(idx);
    revisarAvisos(dt);
    textosTiempo();
    dibujarLinea();
    actualizarBotones();
  }
  requestAnimationFrame(ciclo);
}

// ---------------------------------------------------------------- herramientas de la barra superior
function alternar(boton, activo) { boton.setAttribute("aria-pressed", String(activo)); }

$("b-vel").addEventListener("click", () => { E.velocidades = !E.velocidades; alternar($("b-vel"), E.velocidades); });
$("b-grilla").addEventListener("click", () => {
  E.grilla = !E.grilla;
  alternar($("b-grilla"), E.grilla);
  $("b-grilla").innerHTML = E.grilla ? "▦&nbsp; Ocultar grilla" : "▦&nbsp; Mostrar grilla";
});
$("b-regla").addEventListener("click", () => activarRegla(!E.regla));
function activarRegla(activa) {
  E.regla = activa;
  E.puntosRegla = [];
  alternar($("b-regla"), activa);
  if (activa) {
    cancelarZona();
    E.fichaFija = null;
    capa.style.cursor = "crosshair";
    estado("Regla: haz clic en dos puntos del video para medir la distancia. Esc para salir.", C.info);
  } else {
    capa.style.cursor = "";
    estado("", C.suave);
  }
}
$("b-conteo").addEventListener("click", () => {
  E.conteo = !E.conteo;
  $("app").classList.toggle("sin-conteo", !E.conteo);
  $("b-conteo").textContent = E.conteo ? "Ocultar conteo" : "Mostrar conteo";
  requestAnimationFrame(() => { diseno(); aplicarZoom(); });
});
$("b-panel").addEventListener("click", () => {
  if (estrecho()) return abrirLateral(!$("app").classList.contains("lateral-abierto"));
  const oculto = $("app").classList.toggle("sin-lateral");
  $("b-panel").classList.toggle("oculto", oculto);
  if (oculto) cancelarZona();
  requestAnimationFrame(() => { diseno(); aplicarZoom(); });
});
function abrirLateral(abrir) {
  $("app").classList.toggle("lateral-abierto", abrir);
  $("velo").hidden = !abrir;
}
$("velo").addEventListener("click", () => abrirLateral(false));
$("b-cerrar-lateral").addEventListener("click", () => abrirLateral(false));
$("b-zoom").addEventListener("click", restablecerZoom);

// ---------------------------------------------------------------- controles de reproduccion
$("b-pausa").addEventListener("click", pausar);
$("b-atras10").addEventListener("click", () => irA(video.currentTime - 10));
$("b-atras5").addEventListener("click", () => irA(video.currentTime - 5));
$("b-adelante5").addEventListener("click", () => irA(video.currentTime + 5));
$("b-directo").addEventListener("click", () => {
  if (!E.iniciado || enDirecto()) return;
  irA(E.vivo);
  estado(reproduciendo() ? "Analizando el video…" : "En pausa.", reproduciendo() ? C.ok : C.suave);
});

// ---------------------------------------------------------------- panel lateral: video
$("b-abrir").addEventListener("click", () => {
  const lista = $("lista-videos");
  lista.innerHTML = "";
  for (const v of E.catalogo) {
    const b = document.createElement("button");
    b.className = E.base === `datos/${v.nombre}/` ? "actual" : "";
    b.innerHTML = `<span></span><small>${horaCorta(v.duracion_s)} · ${v.camiones} camiones</small>`;
    b.querySelector("span").textContent = v.titulo;
    b.addEventListener("click", () => {
      if (b.className === "actual") return $("dlg-videos").close();
      location.search = `?demo=${encodeURIComponent(v.nombre)}`;
    });
    lista.appendChild(b);
  }
  $("dlg-videos").showModal();
});
$("b-reiniciar").addEventListener("click", reiniciar);

// ---------------------------------------------------------------- panel lateral: zonas
document.querySelectorAll("#seg-tipo button").forEach((b) => b.addEventListener("click", () => {
  E.tipo = b.dataset.tipo;
  document.querySelectorAll("#seg-tipo button").forEach((o) => {
    o.classList.toggle("activo", o === b);
    o.setAttribute("aria-checked", String(o === b));
  });
  $("app").style.setProperty("--color-zona", COLOR_ZONA[E.tipo]);
  $("t-desc-tipo").textContent = DESC_TIPO[E.tipo];
}));

document.querySelectorAll(".forma").forEach((b) => b.addEventListener("click", () => {
  if (!E.demo) return;
  if (E.forma === b.dataset.forma) { cancelarZona(); estado("Dibujo cancelado.", C.suave); return; }
  if (E.regla) activarRegla(false);
  E.forma = b.dataset.forma;
  E.dibujo = { forma: E.forma, puntos: [] };
  E.fichaFija = null;
  document.querySelectorAll(".forma").forEach((o) => o.classList.toggle("elegida", o === b));
  $("t-ayuda").textContent = AYUDA_FORMA[E.forma];
  capa.style.cursor = "crosshair";
  estado(`Dibujando zona ${NOMBRE_ZONA[E.tipo].toLowerCase()} con ${E.forma.toLowerCase()}. Esc para cancelar.`, COLOR_ZONA[E.tipo]);
  if (estrecho()) abrirLateral(false);
}));

function cancelarZona() {
  E.forma = null;
  E.dibujo = null;
  document.querySelectorAll(".forma").forEach((o) => o.classList.remove("elegida"));
  $("t-ayuda").textContent = AYUDA_INICIAL;
  capa.style.cursor = E.regla ? "crosshair" : "";
}

function simplificar(puntos, tol = 2.5) {
  // Ramer-Douglas-Peucker, igual que app.py (para el dibujo libre).
  if (puntos.length < 3) return puntos.slice();
  const rdp = (p) => {
    const [xa, ya] = p[0], [xb, yb] = p[p.length - 1];
    const largo = Math.hypot(xb - xa, yb - ya) || 1e-9;
    let dmax = 0, imax = 0;
    for (let i = 1; i < p.length - 1; i++) {
      const [x, y] = p[i];
      const d = Math.abs((yb - ya) * x - (xb - xa) * y + xb * ya - yb * xa) / largo;
      if (d > dmax) { dmax = d; imax = i; }
    }
    return dmax > tol ? rdp(p.slice(0, imax + 1)).slice(0, -1).concat(rdp(p.slice(imax))) : [p[0], p[p.length - 1]];
  };
  const [x0, y0] = puntos[0];
  let k = 0, dk = -1;
  puntos.forEach(([x, y], i) => { const d = (x - x0) ** 2 + (y - y0) ** 2; if (d > dk) { dk = d; k = i; } });
  let res = k > 0 && k < puntos.length - 1 ? rdp(puntos.slice(0, k + 1)).slice(0, -1).concat(rdp(puntos.slice(k))) : rdp(puntos);
  if (res.length >= 2 && res[0][0] === res[res.length - 1][0] && res[0][1] === res[res.length - 1][1]) res.pop();
  return res;
}

async function finalizarZona(puntosCanvas) {
  const tipo = E.tipo;
  const G = geom();
  const puntos = puntosCanvas.map(([x, y]) => aTrabajo(x, y, G)).map(([x, y]) => [redondearPar(x), redondearPar(y)]);
  cancelarZona();
  if (puntos.length < 3 || Math.abs(area(puntos)) < 150) { estado("La zona es muy pequeña. Inténtalo de nuevo.", C.error); return; }
  E.zonas.push({ puntos, tipo, nombre: "", limite: null, rol: "" });
  recalcularTodo();
  const z = E.zonas.length - 1;
  const datos = await pedirNombreZona(z, "");
  if (datos) { Object.assign(E.zonas[z], datos); recalcularTodo(); }
  estado(`${nombreZona(z)} (${NOMBRE_ZONA[tipo].toLowerCase()}) creada. El conteo se recalculó con todo el video.`, C.ok);
}

function pedirNombreZona(z, actual, limite = null, rol = "") {
  return new Promise((ok) => {
    const d = $("dlg-zona"), zona = E.zonas[z];
    $("dlg-zona-titulo").textContent = `Nombre para la Zona ${z + 1}`;
    $("dlg-zona-color").style.background = COLOR_ZONA[zona.tipo];
    $("dlg-zona-nombre").value = actual;
    $("dlg-zona-nombre").placeholder = `Zona ${z + 1}`;
    $("dlg-zona-limite").value = limite ? g(limite) : "";
    $("dlg-zona-rol").value = rol || "";
    $("dlg-zona-omitir").textContent = actual || limite ? "Cancelar" : "Omitir";
    let resultado = null;
    $("form-zona").onsubmit = (e) => {
      e.preventDefault();
      const lim = numero($("dlg-zona-limite").value);
      resultado = { nombre: $("dlg-zona-nombre").value.trim().slice(0, 40), limite: lim && lim > 0 ? lim : null,
                    rol: $("dlg-zona-rol").value };
      d.close();
    };
    $("dlg-zona-omitir").onclick = () => d.close();
    $("dlg-zona-nombre").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("dlg-zona-limite").focus(); } };
    d.onclose = () => ok(resultado);
    d.showModal();
    $("dlg-zona-nombre").focus();
  });
}

async function editarZona(z) {
  const datos = await pedirNombreZona(z, E.zonas[z].nombre, E.zonas[z].limite, E.zonas[z].rol);
  if (!datos) return;
  Object.assign(E.zonas[z], datos);
  recalcularTodo();
  estado(`Zona guardada: ${nombreZona(z)}.`, C.ok);
}

$("b-deshacer").addEventListener("click", () => { E.zonas.pop(); recalcularTodo(); });
$("b-borrar").addEventListener("click", async () => {
  if (!E.zonas.length) return;
  if (await confirmar("Borrar zonas", "Se borrarán todas las zonas. ¿Continuar?", "Borrar", "Cancelar")) {
    E.zonas = [];
    recalcularTodo();
  }
});
$("b-zonas-originales").addEventListener("click", () => {
  E.zonas = zonasDelAnalisis();
  E.limiteGeneral = E.demo.limite_general;
  $("e-limite").value = E.limiteGeneral ? g(E.limiteGeneral) : "";
  recalcularTodo();
  estado("Se restauraron las zonas y límites con que se analizó el video.", C.ok);
});

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$("b-guardar-zonas").addEventListener("click", () => {
  if (!E.zonas.length) return;
  // Mismo formato que "Guardar zonas" de la app de escritorio (se puede cargar alla).
  const datos = { zonas: E.zonas.map((z) => z.puntos), tipos: E.zonas.map((z) => z.tipo), nombres: E.zonas.map((z) => z.nombre),
                  limites: E.zonas.map((z) => z.limite), roles: E.zonas.map((z) => z.rol || ""), limite_general: E.limiteGeneral || null };
  if (E.georef) datos.georreferencia = E.georef.aDict();
  descargar("zonas.json", JSON.stringify(datos, null, 2), "application/json");
  estado("Zonas guardadas en zonas.json (sirve también en la app de escritorio).", C.ok);
});

$("b-cargar-zonas").addEventListener("click", () => $("f-zonas").click());
$("f-zonas").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  e.target.value = "";
  if (!archivo) return;
  try {
    const datos = JSON.parse(await archivo.text());
    const nombres = datos.nombres || [], limites = datos.limites || [], roles = datos.roles || [];
    const nuevas = [];
    datos.zonas.forEach((zona, i) => {
      const tipo = datos.tipos[i];
      if (!COLOR_ZONA[tipo]) return;
      let puntos;
      if (zona.length === 4 && zona.every((v) => typeof v === "number")) {
        const [x, y, w, h] = zona;                     // formato antiguo: rectangulo
        puntos = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      } else puntos = zona.map((p) => [Number(p[0]), Number(p[1])]);
      if (puntos.length >= 3) {
        nuevas.push({ puntos: puntos.map(([x, y]) => [redondearPar(x), redondearPar(y)]), tipo,
                      nombre: typeof nombres[i] === "string" ? nombres[i].slice(0, 40) : "",
                      limite: typeof limites[i] === "number" && limites[i] > 0 ? limites[i] : null,
                      rol: ROLES[roles[i]] ? roles[i] : "" });
      }
    });
    E.zonas = nuevas;
    if (typeof datos.limite_general === "number") {
      E.limiteGeneral = datos.limite_general > 0 ? datos.limite_general : null;
      $("e-limite").value = E.limiteGeneral ? g(E.limiteGeneral) : "";
    }
    recalcularTodo();
    estado(`${nuevas.length} zonas cargadas. El conteo se recalculó con todo el video.`, C.ok);
    if (datos.georreferencia) toast("El archivo trae una calibración: en la demostración se mantiene la del análisis original.");
  } catch {
    estado("El archivo no tiene un formato válido de zonas.", C.error);
  }
});

// ---------------------------------------------------------------- calibracion, limite, velocidad, Excel
function actualizarCalibracion() {
  const geo = E.georef, el = $("t-calibracion");
  if (!geo) { el.textContent = "Sin calibrar: las medidas están en píxeles."; el.style.color = C.suave; return; }
  const [W, H] = E.demo.resolucion;
  const medida = `${miles(W * geo.escalaMPx)}\u00a0×\u00a0${miles(H * geo.escalaMPx)}\u00a0m`;
  const fuente = String(geo.info.fuente || "");
  const pct = geo.info.incertidumbre_escala_pct;
  if (geo.info.revisar) {
    el.textContent = `⚠ Revisa la calibración: ${geo.info.revisar}. Las velocidades pueden salir mal.`;
    el.style.color = C.acento;
  } else if (geo.esPlano() && (fuente.startsWith("Solo camión") || fuente.startsWith("Automática"))) {
    const origen = fuente.startsWith("Automática") ? "automática, camión de 15 m" : "con el tamaño del camión";
    el.textContent = `≈ Aproximada (${origen}, ±\u00a0${g(pct || 7)}\u00a0%): ${medida}. Para más precisión, calibra con una distancia conocida.`;
    el.style.color = C.acento;
  } else if (geo.esPlano()) {
    el.textContent = `✓ Plano en metros: ${medida}${pct ? ` · ±\u00a0${pct.toFixed(1)}\u00a0%` : ""}`;
    el.style.color = C.ok;
  } else {
    el.textContent = `✓ Coordenadas UTM: ${geo.puntos.length} puntos${geo.errorMedible() ? ` · error ${geo.errorM.toFixed(2)} m` : ""}.`;
    el.style.color = C.ok;
  }
}

$("b-calibracion").addEventListener("click", () => {
  const geo = E.georef, c = $("calib-contenido");
  if (!geo) {
    c.innerHTML = "<p>Este video se analizó sin calibración, así que las medidas están en píxeles.</p>";
  } else {
    const [W, H] = E.demo.resolucion, i = geo.info;
    const filas = [
      ["Método", geo.esPlano() ? "Plano local: (0; 0) en la esquina inferior izquierda" : geo.metodo],
      ["Escala calculada con", i.fuente || "—"],
      ["Escala", `1 m = ${(1 / geo.escalaMPx).toFixed(1)} píxeles del video`],
      ["El video cubre", `${miles(W * geo.escalaMPx)} m × ${miles(H * geo.escalaMPx)} m`],
    ];
    if (i.precision_m) filas.push(["Precisión de posición", `± ${i.precision_m.toFixed(2)} m`]);
    if (i.incertidumbre_escala_pct) filas.push(["Precisión de distancias", `± ${i.incertidumbre_escala_pct.toFixed(1)} %`]);
    if (i.largo_m) filas.push(["Largo del camión usado", `${g(i.largo_m)} m (${i.camiones_medidos || "?"} camiones medidos)`]);
    c.innerHTML = `<dl class="datos-calib">${filas.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>
      <p class="suave">Es la calibración con que se analizó el video en la laptop. El editor completo (camión, distancias conocidas y puntos UTM) llega en la próxima entrega de la web.</p>`;
  }
  $("dlg-calibracion").showModal();
});

let tLimite = null;
$("e-limite").addEventListener("input", () => {
  clearTimeout(tLimite);
  tLimite = setTimeout(() => {
    const v = numero($("e-limite").value);
    const nuevo = v && v > 0 ? v : null;
    if (nuevo === (E.limiteGeneral || null)) return;
    E.limiteGeneral = nuevo;
    recalcularTodo();
    estado(nuevo ? `Límite general: ${g(nuevo)} km/h. Los excesos se recalcularon con todo el video.` : "Sin límite general.", C.ok);
  }, 350);
});

document.querySelectorAll("#seg-velocidad button").forEach((b) => b.addEventListener("click", () => {
  if (b.classList.contains("activo")) return;
  toast(`En la demostración el video ya está analizado (modo ${E.demo?.modo}). Elegir la velocidad será parte del modo análisis.`);
}));

async function exportarExcel() {
  if (!E.demo) return;
  if (E.cambiado && !(await confirmar("¿Descargar el Excel del análisis?",
      "El Excel se generó en la laptop con las zonas y límites originales del análisis. Los cambios que hiciste " +
      "aquí no aparecen en ese archivo.", "Descargar igual", "Cancelar"))) return;
  const a = Object.assign(document.createElement("a"), { href: E.base + "reporte.xlsx",
                                                          download: `reporte_${E.demo.nombre}.xlsx` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  estado("Descargando el reporte Excel…", C.ok);
}
$("b-exportar").addEventListener("click", exportarExcel);
$("b-exportar-res").addEventListener("click", exportarExcel);

// ---------------------------------------------------------------- mouse y pantalla tactil
function posicion(e) {
  const r = capa.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
const dentroVideo = ([x, y]) => x >= E.rect.x && x <= E.rect.x + E.rect.w && y >= E.rect.y && y <= E.rect.y + E.rect.h;

function actualizarCoordenadas(p) {
  const el = $("t-coord");
  if (!p || !E.georef || !dentroVideo(p)) { if (el.textContent) el.textContent = ""; return; }
  const [x, y] = aOriginal(...aTrabajo(...p));
  const [a, b] = E.georef.esPlano() ? E.georef.aPlano(x, y) : E.georef.aCoordenadas(x, y);
  el.textContent = E.georef.esPlano() ? `X ${miles(a, 1)} m   Y ${miles(b, 1)} m` : `E ${miles(a, 1)}   N ${miles(b, 1)}`;
}

function zonaBajo(p) {
  if (!dentroVideo(p)) return null;
  const [x, y] = aTrabajo(...p);
  let mejor = null, amin = Infinity;
  E.zonas.forEach((z, i) => {
    if (puntoEnPoligono(x, y, z.puntos)) { const a = Math.abs(area(z.puntos)); if (a < amin) { amin = a; mejor = i; } }
  });
  return mejor;
}

capa.addEventListener("contextmenu", (e) => e.preventDefault());
capa.addEventListener("wheel", (e) => {
  if (!E.demo) return;
  e.preventDefault();
  acercar(e.deltaY < 0 ? 1.25 : 1 / 1.25, ...posicion(e));
}, { passive: false });

capa.addEventListener("pointerdown", (e) => {
  if (!E.demo) return;
  capa.setPointerCapture(e.pointerId);
  const p = posicion(e);
  E.punteros.set(e.pointerId, p);
  if (E.punteros.size === 2) {                            // dos dedos: zoom con pellizco
    const [a, b] = [...E.punteros.values()];
    E.gesto = { tipo: "pellizco", d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: E.vista.zoom };
    if (E.dibujo && E.dibujo.forma !== "Polígono") E.dibujo.puntos = [];
    return;
  }
  E.gesto = { tipo: "toque", x: p[0], y: p[1], t: performance.now(), cx: E.vista.cx, cy: E.vista.cy, movido: false,
              boton: e.button };
  if (e.button === 2) return;                             // clic derecho: mover la vista
  if (E.regla) {
    if (!E.georef || !dentroVideo(p)) return;
    if (E.puntosRegla.length >= 2) E.puntosRegla = [];
    E.puntosRegla.push(aTrabajo(...p));
    if (E.puntosRegla.length === 2) {
      estado(`Distancia medida: ${miles(metrosEntre(...E.puntosRegla), 1)} m. Haz clic otra vez para una nueva medida.`, C.info);
    }
    return;
  }
  const d = E.dibujo;
  if (d) {
    const pt = aTrabajo(...p);
    if (d.forma === "Rectángulo" || d.forma === "Círculo") d.puntos = [pt, pt];
    else if (d.forma === "Libre") { d.puntos = [pt]; d.canvas = [p]; }
    else if (d.forma === "Polígono") {
      if (d.puntos.length >= 3) {
        const [x0, y0] = aCanvas(...d.puntos[0]);
        if ((p[0] - x0) ** 2 + (p[1] - y0) ** 2 <= 14 ** 2) { cerrarPoligono(); return; }
      }
      d.puntos.push(pt);
    }
  }
});

capa.addEventListener("pointermove", (e) => {
  if (!E.demo) return;
  const p = posicion(e);
  if (e.pointerType === "mouse") E.mouse = p;
  actualizarCoordenadas(p);
  if (E.punteros.has(e.pointerId)) E.punteros.set(e.pointerId, p);
  const gs = E.gesto;
  if (gs?.tipo === "pellizco" && E.punteros.size === 2) {
    const [a, b] = [...E.punteros.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    acercar((gs.zoom * d / gs.d) / E.vista.zoom, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    return;
  }
  const dib = E.dibujo;
  if (dib && E.punteros.has(e.pointerId) && gs?.boton !== 2) {
    if ((dib.forma === "Rectángulo" || dib.forma === "Círculo") && dib.puntos.length === 2) dib.puntos[1] = aTrabajo(...p);
    else if (dib.forma === "Libre" && dib.canvas) {
      const [xa, ya] = dib.canvas[dib.canvas.length - 1];
      if ((p[0] - xa) ** 2 + (p[1] - ya) ** 2 >= 9) { dib.canvas.push(p); dib.puntos.push(aTrabajo(...p)); }
    }
    return;
  }
  if (dib && dib.forma === "Polígono") dib.cursor = aTrabajo(...p);
  if (gs?.tipo === "toque" && E.punteros.has(e.pointerId)) {
    if (Math.abs(p[0] - gs.x) + Math.abs(p[1] - gs.y) > 5) gs.movido = true;
    if (gs.movido && E.vista.zoom > 1 && (!E.regla || gs.boton === 2) && (!dib || gs.boton === 2)) {
      const { ex, ey } = geom();
      E.vista.cx = gs.cx - (p[0] - gs.x) / ex;
      E.vista.cy = gs.cy - (p[1] - gs.y) / ey;
      aplicarZoom();
      capa.style.cursor = "grabbing";
    }
  }
  if (e.pointerType === "mouse" && !dib && !E.regla) E.zonaHover = zonaBajo(p);
});

capa.addEventListener("pointerup", (e) => finPuntero(e));
capa.addEventListener("pointercancel", (e) => finPuntero(e, true));
let ultimoToque = 0;
function finPuntero(e, cancelado = false) {
  const gs = E.gesto, p = posicion(e);
  E.punteros.delete(e.pointerId);
  if (gs?.tipo === "pellizco") { if (!E.punteros.size) E.gesto = null; return; }
  E.gesto = null;
  capa.style.cursor = E.forma || E.regla ? "crosshair" : "";
  if (cancelado || !gs) return;
  const d = E.dibujo;
  if (gs.boton === 2) {                                    // clic derecho sin arrastrar: borra el ultimo punto
    if (!gs.movido && d?.forma === "Polígono" && d.puntos.length) d.puntos.pop();
    return;
  }
  if (d) {
    const G = geom();
    if ((d.forma === "Rectángulo") && d.puntos.length === 2) {
      const [[ax, ay], [bx, by]] = d.puntos.map((q) => aCanvas(...q, G));
      finalizarZona([[ax, ay], [bx, ay], [bx, by], [ax, by]]);
    } else if (d.forma === "Círculo" && d.puntos.length === 2) {
      const [[ax, ay], [bx, by]] = d.puntos.map((q) => aCanvas(...q, G));
      const r = Math.hypot(bx - ax, by - ay);
      finalizarZona(Array.from({ length: 36 }, (_, k) => [ax + r * Math.cos(2 * Math.PI * k / 36), ay + r * Math.sin(2 * Math.PI * k / 36)]));
    } else if (d.forma === "Libre" && d.canvas) {
      finalizarZona(simplificar(d.canvas));
    }
    return;
  }
  if (E.regla || gs.movido) return;
  // Toque o clic simple: en pantallas tactiles muestra la ficha del camion tocado.
  const idx = indice(video.currentTime);
  const cam = E.iniciado ? camionBajo(camionesEn(idx, geom()), ...p) : null;
  if (e.pointerType !== "mouse") {
    E.fichaFija = cam ? (E.fichaFija === cam.pid ? null : cam.pid) : null;
    const ahora = performance.now();
    if (!cam && ahora - ultimoToque < 320 && E.vista.zoom > 1) restablecerZoom();   // doble toque
    ultimoToque = ahora;
  }
}

capa.addEventListener("dblclick", (e) => {
  const d = E.dibujo;
  if (d?.forma === "Polígono") {
    const n = d.puntos.length;                            // el doble clic agrego el punto dos veces
    if (n >= 2 && d.puntos[n - 1][0] === d.puntos[n - 2][0] && d.puntos[n - 1][1] === d.puntos[n - 2][1]) d.puntos.pop();
    cerrarPoligono();
  } else if (!d && !E.regla && E.vista.zoom > 1) restablecerZoom();
});
capa.addEventListener("pointerleave", (e) => {
  if (e.pointerType !== "mouse") return;
  E.mouse = null;
  E.zonaHover = null;
  actualizarCoordenadas(null);
});

function cerrarPoligono() {
  const d = E.dibujo;
  if (!d || d.forma !== "Polígono") return;
  if (d.puntos.length < 3) { estado("Un polígono necesita al menos 3 puntos.", C.error); return; }
  const G = geom();
  finalizarZona(d.puntos.map((q) => aCanvas(...q, G)));
}

// ---------------------------------------------------------------- teclado
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  const escribiendo = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (E.pestana === "resultados") return;
  if (e.key === " " && !escribiendo && !E.dibujo) {
    e.preventDefault();
    pausar();
  } else if (e.key === "Escape") {
    if (E.regla) activarRegla(false);
    else if (E.dibujo) { cancelarZona(); estado("Dibujo cancelado.", C.suave); }
    E.fichaFija = null;
    abrirLateral(false);
  } else if (e.key === "Enter" && E.dibujo?.forma === "Polígono") {
    cerrarPoligono();
  } else if (e.key === "Backspace" && !escribiendo && E.dibujo?.forma === "Polígono" && E.dibujo.puntos.length) {
    e.preventDefault();
    E.dibujo.puntos.pop();
  }
});

// ---------------------------------------------------------------- pestanas Monitoreo / Resultados
// Los resultados se abren en la misma pagina (no en otra ventana): el video se pausa y al volver
// sigue en el mismo segundo. La direccion cambia a #resultados para poder compartirla.
E.pestana = "monitoreo";
const contextoResultados = {
  E, video, get base() { return E.base; },
  irMonitoreo: () => cambiarPestana("monitoreo"),
  verMomento: (t) => {
    // Desde una tabla: ir a ese momento del video (2 s antes, para ver lo que pasa).
    cambiarPestana("monitoreo");
    const destino = Math.max(0, t - 2);
    if (!E.iniciado) { E.iniciado = true; E.tAvisos = destino; }
    if (destino > E.vivo) E.vivo = Math.min(duracion(), t + 0.5);
    video.pause();
    irA(destino);
    estado(`Viendo el segundo ${horaCorta(destino)}. Presiona Continuar para reproducir.`, C.acento);
    actualizarBotones();
  },
};

function cambiarPestana(nombre, actualizarDireccion = true) {
  if (!E.demo && nombre === "resultados") return;
  const res = nombre === "resultados";
  const antes = E.pestana;
  E.pestana = nombre;
  $("app").classList.toggle("modo-resultados", res);
  $("vista-monitoreo").hidden = res;
  $("vista-resultados").hidden = !res;
  for (const [id, activo] of [["tab-monitoreo", !res], ["tab-resultados", res]]) {
    $(id).setAttribute("aria-selected", String(activo));
    $(id).tabIndex = activo ? 0 : -1;
  }
  if (actualizarDireccion) history.replaceState(null, "", res ? "#resultados" : location.pathname + location.search);
  if (res) {
    if (antes !== "resultados") {
      if (reproduciendo()) { video.pause(); estado("En pausa (viendo resultados).", C.suave); }
      if (E.regla) activarRegla(false);
      if (E.dibujo) cancelarZona();
      abrirLateral(false);
      actualizarBotones();
    }
    $("vista-resultados").scrollTop = 0;
    if (antes !== "resultados") window.scrollTo(0, 0);
    const hayDirecto = E.iniciado && E.vivo < duracion() - 0.5;
    mostrarResultados(contextoResultados, hayDirecto ? "directo" : "todo");
  } else {
    window.scrollTo(0, 0);                       // en el celular la pagina se desplaza entera
    requestAnimationFrame(() => { diseno(); aplicarZoom(); crearRanuras(); });
  }
}
$("tab-monitoreo").addEventListener("click", () => cambiarPestana("monitoreo"));
$("tab-resultados").addEventListener("click", () => cambiarPestana("resultados"));
$("tab-monitoreo").addEventListener("keydown", (e) => { if (e.key === "ArrowRight") { $("tab-resultados").focus(); cambiarPestana("resultados"); } });
$("tab-resultados").addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") { $("tab-monitoreo").focus(); cambiarPestana("monitoreo"); } });
document.querySelectorAll("#seg-corte button").forEach((b) => b.addEventListener("click", () => elegirCorte(b.dataset.corte)));
document.querySelectorAll("#seg-tabla button").forEach((b) => b.addEventListener("click", () => elegirTabla(b.dataset.tabla)));
window.addEventListener("hashchange", () => cambiarPestana(location.hash === "#resultados" ? "resultados" : "monitoreo", false));
window.addEventListener("resize", () => { if (E.pestana === "resultados") redimensionarResultados(); });

// ---------------------------------------------------------------- arranque
new ResizeObserver(() => { diseno(); aplicarZoom(); }).observe($("marco"));
window.addEventListener("resize", () => { crearRanuras(); if (!estrecho()) abrirLateral(false); });
crearRanuras();
$("app").style.setProperty("--color-zona", COLOR_ZONA.acumulativa);
actualizarBotones();
requestAnimationFrame(ciclo);
cargar().then(() => { if (location.hash === "#resultados") cambiarPestana("resultados", false); });
