// Pestaña "En vivo": analiza en tiempo real la pantalla compartida, un video de la PC o la cámara,
// con el mismo modelo (best_obb_v2.onnx) y el mismo seguimiento que la app de escritorio.
// Todo corre en la computadora del visitante (tarjeta grafica con WebGPU); no se sube nada.
import { Detector } from "./detector.js";
import { MotorVivo, ANCHO_TRABAJO, ALTO_TRABAJO } from "./motor_vivo.js";

const ORT_VERSION = "1.30.0";
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODELO = "datos/best_obb_v2.onnx";
const FPS = 30;                                   // los cuadros se numeran como en un video de 30 cuadros/s
const COLOR_CAJA = "#00FFFF";

const $ = (id) => document.getElementById(id);
const mmss = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

const V = {
  ort: null, det: null, motor: null, cargando: null, proveedor: "", tarjeta: "",
  activo: false, flujo: null, url: null, fuente: "", ultimaFila: null, nUltima: 0,
  tiempos: [], dibujando: false, visible: false,
};
const video = $("v-video"), lienzo = $("v-lienzo"), ctx = lienzo.getContext("2d");

// ---------------------------------------------------------------- carga del modelo (solo al usarlo)
async function importarOrt() {
  for (const base of [ORT_CDN, new URL("js/vendor/ort/", location.href).href]) {
    try {
      const ort = await import(base + "ort.all.min.mjs");
      ort.env.wasm.wasmPaths = base;
      ort.env.wasm.numThreads = 1;
      return ort;
    } catch { /* se prueba la siguiente */ }
  }
  throw new Error("No se pudo descargar el motor de inteligencia artificial. Revisa tu conexión a internet.");
}

function cargar() {
  if (V.cargando) return V.cargando;
  V.cargando = (async () => {
    mensaje("Preparando el análisis… (la primera vez descarga unos 40 MB; luego queda guardado)");
    V.ort = await importarOrt();
    const prueba = new URLSearchParams(location.search).get("motor");
    const lista = prueba ? [prueba] : (navigator.gpu ? ["webgpu", "wasm"] : ["wasm"]);
    for (const p of lista) {
      try {
        if (p === "webgpu") {
          // En laptops con dos tarjetas (Intel + NVIDIA) se pide la de alto rendimiento.
          const adaptador = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
          if (!adaptador) throw new Error("sin tarjeta gráfica");
          try { V.ort.env.webgpu.adapter = adaptador; } catch { /* version sin esta opcion */ }
          try { V.ort.env.webgpu.powerPreference = "high-performance"; } catch { /* idem */ }
          const i = adaptador.info || {};
          V.tarjeta = [i.vendor, i.architecture].filter(Boolean).join(" ");
        }
        V.det = await Detector.crear(V.ort, MODELO, [p]);
        V.proveedor = p;
        $("v-motor").textContent = p === "webgpu" ? `Tarjeta gráfica${V.tarjeta ? ` (${V.tarjeta})` : ""}` : "Procesador";
        return;
      } catch (e) { console.warn("No se pudo usar", p, e); }
    }
    throw new Error("Este navegador no pudo cargar el modelo. Usa Chrome o Edge actualizados en una computadora.");
  })();
  V.cargando.catch(() => { V.cargando = null; });
  return V.cargando;
}

// ---------------------------------------------------------------- fuentes
async function empezar(tipo, obtener) {
  try {
    detener(false);
    V.fuente = tipo;
    botones(true);
    await cargar();
    const fuente = await obtener();
    if (!fuente) { botones(false); mensaje(null); return; }
    if (fuente.flujo) {
      V.flujo = fuente.flujo;
      video.srcObject = fuente.flujo;
      video.loop = false;
      fuente.flujo.getVideoTracks()[0]?.addEventListener("ended", () => detener());
    } else {
      V.url = fuente.url;
      video.srcObject = null;
      video.src = fuente.url;
      video.loop = false;
    }
    await video.play();
    V.motor = new MotorVivo({ fps: FPS, salto: 1 });
    V.ultimaFila = null; V.tiempos = [];
    V.activo = true;
    mensaje(null);
    $("v-insignia").hidden = false;
    $("v-ayuda").textContent = tipo === "pantalla"
      ? "Analizando lo que compartiste. Puedes volver a la ventana del simulador: el análisis sigue aquí."
      : "Analizando… Los números de los camiones se mantienen aunque se crucen o se detengan en la cola.";
    analizar();
    if (!V.dibujando) { V.dibujando = true; requestAnimationFrame(dibujar); }
  } catch (e) {
    detener(false);
    mensaje(e.name === "NotAllowedError" ? "No se dio permiso. Vuelve a intentarlo y elige qué compartir." : e.message);
  }
}

function detener(avisar = true) {
  const habia = V.activo;
  V.activo = false;
  if (V.flujo) { V.flujo.getTracks().forEach((t) => t.stop()); V.flujo = null; }
  video.pause();
  video.removeAttribute("src");
  video.srcObject = null;
  video.load();
  if (V.url) { URL.revokeObjectURL(V.url); V.url = null; }
  $("v-insignia").hidden = true;
  botones(false);
  if (avisar && habia && V.motor) {
    mensaje(`Análisis detenido: ${V.motor.flota.registros.size} camiones seguidos en ${mmss(V.motor.tiempo())}. Elige otra fuente para empezar de nuevo.`);
  }
}

function botones(ocupado) {
  for (const id of ["v-pantalla", "v-archivo", "v-camara"]) $(id).disabled = ocupado;
  $("v-detener").disabled = !ocupado;
  if (!navigator.mediaDevices?.getDisplayMedia) $("v-pantalla").disabled = true;
  if (!navigator.mediaDevices?.getUserMedia) $("v-camara").disabled = true;
}

function mensaje(texto) {
  const m = $("v-mensaje");
  m.hidden = !texto;
  if (texto) m.textContent = texto;
}

// ---------------------------------------------------------------- analisis (tan rapido como pueda la PC)
async function analizar() {
  const motor = V.motor;
  while (V.activo && V.motor === motor) {
    if (video.ended) { detener(); break; }
    if (video.paused || video.readyState < 2 || !video.videoWidth) { await esperar(60); continue; }
    const n = Math.floor(video.currentTime * FPS) + 1;          // cuadro que se ve ahora
    if (n <= motor.contador) { await siguienteCuadro(); continue; }
    const t0 = performance.now();
    // Igual que la app: el cuadro se lleva a 800 x 600 y se analiza; las cajas salen en ese cuadro.
    const dets = await V.det.detectar(video, ANCHO_TRABAJO, ALTO_TRABAJO);
    if (!V.activo || V.motor !== motor) break;
    while (motor.contador < n - 1) motor.paso(null);            // cuadros que no se alcanzaron a analizar
    V.ultimaFila = motor.paso(dets);
    V.nUltima = n;
    V.tiempos.push(performance.now() - t0);
    if (V.tiempos.length > 30) V.tiempos.shift();
    actualizarPanel();
    await esperar(0);
  }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const siguienteCuadro = () => new Promise((r) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => r()) : setTimeout(r, 16)));

function actualizarPanel() {
  const m = V.motor, prom = V.tiempos.reduce((s, v) => s + v, 0) / V.tiempos.length;
  $("v-activos").textContent = V.ultimaFila ? V.ultimaFila[2] : 0;
  $("v-seguidos").textContent = m.flota.registros.size;
  $("v-tiempo").textContent = mmss(m.tiempo());
  const fps = 1000 / prom;
  $("v-fps").textContent = `${fps.toFixed(fps < 10 ? 1 : 0)} veces`;
  const c = $("v-consejo");
  const lento = V.tiempos.length >= 15 && fps < 8;
  c.hidden = !lento;
  if (lento) {
    c.className = "vivo-nota vivo-alerta";
    c.textContent = V.proveedor === "webgpu"
      ? "Va lento: tu navegador usa una tarjeta gráfica básica. Si tu PC tiene otra (NVIDIA o AMD), en Windows ve a Configuración → Sistema → Pantalla → Gráficos, elige Google Chrome → Alto rendimiento, y vuelve a abrir Chrome."
      : "Va lento porque se está usando solo el procesador. Prueba en una computadora con tarjeta gráfica y Chrome o Edge actualizados.";
  }
}

// ---------------------------------------------------------------- dibujo (fluido, a la velocidad de la pantalla)
function rectVideo(W, H) {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9, e = Math.min(W / vw, H / vh);
  return { x: (W - vw * e) / 2, y: (H - vh * e) / 2, w: vw * e, h: vh * e };
}

/** Cajas que se ven ahora: las del ultimo analisis, adelantadas con la velocidad de cada camion. */
function camionesAhora() {
  const m = V.motor, fila = V.ultimaFila;
  if (!m || !fila) return [];
  const nAhora = Math.max(V.nUltima, video.currentTime * FPS + 1);
  const adelanto = nAhora - V.nUltima;
  return fila[3].map(([pid, x, y, w, h, , , poli]) => {
    const r = m.flota.registros.get(pid);
    let caja = [x, y, w, h];
    if (r && r.estado === "ACTIVE" && adelanto > 0) caja = caja.map((v, k) => v + r.vel[k] * Math.min(adelanto, 15));
    return { pid, caja, poli };
  });
}

function dibujar() {
  if (!V.dibujando) return;
  requestAnimationFrame(dibujar);
  if (!V.visible) return;
  const dpr = window.devicePixelRatio || 1, W = lienzo.clientWidth, H = lienzo.clientHeight;
  if (!W) return;
  if (lienzo.width !== Math.round(W * dpr)) lienzo.width = Math.round(W * dpr);
  if (lienzo.height !== Math.round(H * dpr)) lienzo.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!V.activo || !video.videoWidth) return;
  const r = rectVideo(W, H);
  ctx.drawImage(video, r.x, r.y, r.w, r.h);
  const ex = r.w / ANCHO_TRABAJO, ey = r.h / ALTO_TRABAJO;
  const aC = (x, y) => [r.x + x * ex, r.y + y * ey];
  const cam = camionesAhora().map((c) => {
    const [x, y, w, h] = c.caja, cx = x + w / 2, cy = y + h / 2;
    const pts = c.poli ? [0, 2, 4, 6].map((i) => aC(c.poli[i] + cx, c.poli[i + 1] + cy)) : null;
    const [x1, y1] = aC(x, y), [x2, y2] = aC(x + w, y + h);
    return { ...c, pts, x1, y1, x2, y2 };
  });
  // misma apariencia que Monitoreo (deteccion_camiones.dibujar_camiones)
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLOR_CAJA;
  for (const c of cam) {
    ctx.beginPath();
    if (c.pts) { c.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
    else ctx.rect(c.x1, c.y1, c.x2 - c.x1, c.y2 - c.y1);
    ctx.stroke();
  }
  ctx.font = "600 11px IBM Plex Sans, sans-serif";
  const ocupadas = [];
  for (const c of cam.sort((a, b) => a.y1 - b.y1)) {
    const texto = String(c.pid), ew = ctx.measureText(texto).width + 8, eh = 15;
    const opciones = [[c.x1, c.y1 - eh], [c.x2 - ew, c.y1 - eh], [c.x1, c.y2], [c.x2 - ew, c.y2], [c.x1 - ew, c.y1], [c.x2, c.y1]];
    let elegido = null;
    for (let [px, py] of opciones) {
      px = Math.min(Math.max(r.x, px), r.x + r.w - ew);
      py = Math.min(Math.max(r.y, py), r.y + r.h - eh);
      const b = [px, py, px + ew, py + eh];
      if (!ocupadas.some((o) => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3])) { elegido = b; break; }
    }
    if (!elegido) { const px = Math.min(Math.max(r.x, c.x1), r.x + r.w - ew), py = Math.max(r.y, c.y1 - eh); elegido = [px, py, px + ew, py + eh]; }
    ocupadas.push(elegido);
    ctx.fillStyle = COLOR_CAJA;
    ctx.fillRect(elegido[0], elegido[1], ew, eh);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(texto, elegido[0] + ew / 2, elegido[1] + eh / 2 + 0.5);
  }
}

// ---------------------------------------------------------------- inicio
export function iniciarVivo() {
  $("v-pantalla").addEventListener("click", () => empezar("pantalla", async () => {
    const flujo = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    return { flujo };
  }));
  $("v-camara").addEventListener("click", () => empezar("camara", async () => {
    const flujo = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: "environment" }, audio: false });
    return { flujo };
  }));
  $("v-archivo").addEventListener("click", () => $("v-entrada").click());
  $("v-entrada").addEventListener("change", () => {
    const f = $("v-entrada").files[0];
    $("v-entrada").value = "";
    if (f) empezar("archivo", async () => ({ url: URL.createObjectURL(f) }));
  });
  $("v-detener").addEventListener("click", () => detener());
  botones(false);
  if (!navigator.mediaDevices?.getDisplayMedia) {
    $("v-ayuda").textContent = "En este dispositivo no se puede compartir la pantalla (pasa en celulares). Usa una computadora con Chrome o Edge, o prueba con un video o la cámara.";
  }
}

/** La pestaña se muestra u oculta (el analisis sigue aunque no se vea). */
export function vivoVisible(si) {
  V.visible = si;
  if (si && !V.dibujando) { V.dibujando = true; requestAnimationFrame(dibujar); }
}

/** Para las pruebas automaticas: empezar con una URL de video. */
export function vivoProbar(url) { return empezar("archivo", async () => ({ url })); }
export const estadoVivo = () => ({ activo: V.activo, proveedor: V.proveedor, fila: V.ultimaFila, contador: V.motor?.contador,
  seguidos: V.motor?.flota.registros.size, tiempos: [...V.tiempos] });
