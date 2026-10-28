// "Analiza tu propio video": sube el video al servidor (Modal), muestra el avance y,
// al terminar, lo abre en la misma pagina (Monitoreo y Resultados) con ?trabajo=<id>.
// El video y sus resultados se borran solos en el servidor a las 24 horas.
import { SERVIDOR_ANALISIS } from "./config.js";

const $ = (id) => document.getElementById(id);
const CLAVE_TRABAJO = "camiones.trabajo_en_curso";
const CLAVE_CODIGO = "camiones.codigo";
const ETAPAS = {
  subido: "Video recibido", preparando: "Preparando el video", en_cola: "En espera del servidor",
  analizando: "Analizando tu video", listo: "¡Listo!", error: "No se pudo analizar",
};

const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const escribir = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export const servidorConfigurado = () => !!SERVIDOR_ANALISIS;
export const urlArchivos = (id) => `${SERVIDOR_ANALISIS}/trabajos/${encodeURIComponent(id)}/archivo/`;

export async function estadoTrabajo(id) {
  const r = await fetch(`${SERVIDOR_ANALISIS}/trabajos/${encodeURIComponent(id)}`, { cache: "no-store" });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(datos.error || "No disponible"), { status: r.status });
  return datos;
}

let limites = null, sondeo = null;

/** Prepara la pestaña "Analizar mi video" del dialogo (una vez). */
export function iniciarSubida() {
  $("form-subir").addEventListener("submit", (e) => { e.preventDefault(); subir(); });
  $("f-video").addEventListener("change", () => {
    const f = $("f-video").files[0];
    $("f-video-info").textContent = f ? `${f.name} · ${(f.size / 1e6).toFixed(1)} MB` : "";
    if (f && limites && f.size > limites.max_mb * 1024 * 1024) {
      $("f-video-info").textContent += ` — pesa más de ${limites.max_mb} MB`;
    }
  });
  $("b-otro").addEventListener("click", () => mostrar("formulario"));
  $("b-ver-trabajo").addEventListener("click", () => {
    const id = $("b-ver-trabajo").dataset.id;
    location.search = `?trabajo=${encodeURIComponent(id)}`;
  });
  const codigo = leer(CLAVE_CODIGO);
  if (codigo) $("f-codigo").value = codigo;
}

/** Al abrir la pestaña: comprueba el servidor y retoma un analisis en curso. */
export async function alAbrirSubida() {
  const nota = $("srv-estado");
  if (!SERVIDOR_ANALISIS) {
    nota.className = "srv-estado apagado";
    nota.textContent = "El análisis de videos propios todavía no está disponible en esta página.";
    $("b-subir").disabled = true;
    return;
  }
  const pendiente = leer(CLAVE_TRABAJO);
  if (pendiente && !sondeo) seguir(pendiente);
  nota.className = "srv-estado";
  nota.textContent = "Comprobando el servidor…";
  try {
    const r = await fetch(`${SERVIDOR_ANALISIS}/estado`, { cache: "no-store" });
    if (!r.ok) throw new Error();
    limites = await r.json();
    $("t-limites").textContent = `Hasta ${limites.max_minutos} minutos y ${limites.max_mb} MB. ` +
      `Se borra a las ${limites.horas_guardado} horas.`;
    if (!limites.codigo_configurado) {
      nota.className = "srv-estado apagado";
      nota.textContent = "El servidor está encendido, pero aún no tiene un código de acceso configurado.";
      $("b-subir").disabled = true;
    } else if (limites.disponibles_hoy <= 0) {
      nota.className = "srv-estado apagado";
      nota.textContent = "Ya se alcanzó el máximo de análisis de hoy. Vuelve a intentarlo mañana.";
      $("b-subir").disabled = true;
    } else {
      nota.className = "srv-estado encendido";
      nota.textContent = `Servidor disponible (en la nube) · quedan ${limites.disponibles_hoy} análisis hoy`;
      $("b-subir").disabled = false;
    }
  } catch {
    nota.className = "srv-estado apagado";
    nota.textContent = "No se pudo conectar con el servidor de análisis. Revisa tu internet o inténtalo más tarde.";
    $("b-subir").disabled = true;
  }
}

function mostrar(parte) {
  $("form-subir").hidden = parte !== "formulario";
  $("subida-progreso").hidden = parte === "formulario";
}

function pintar({ titulo, texto, avance, nivel = "", listo = false, id = null }) {
  mostrar("progreso");
  $("prog-titulo").textContent = titulo;
  $("prog-texto").textContent = texto || "";
  const barra = $("prog-barra");
  barra.parentElement.className = `barra-progreso ${nivel}`;
  barra.parentElement.hidden = avance == null;
  barra.style.width = `${Math.round(Math.max(0, Math.min(1, avance || 0)) * 100)}%`;
  $("prog-barra").parentElement.setAttribute("aria-valuenow", String(Math.round((avance || 0) * 100)));
  $("b-ver-trabajo").hidden = !listo;
  if (id) $("b-ver-trabajo").dataset.id = id;
  $("b-otro").hidden = !(listo || nivel === "error");
  $("prog-cerrar").hidden = listo || nivel === "error";
}

function subir() {
  const archivo = $("f-video").files[0];
  const codigo = $("f-codigo").value.trim();
  if (!archivo) return pintarError("Elige un video primero.", true);
  if (!codigo) return pintarError("Escribe el código de acceso.", true);
  if (limites && archivo.size > limites.max_mb * 1024 * 1024) {
    return pintarError(`El video pesa ${(archivo.size / 1e6).toFixed(0)} MB; el máximo es ${limites.max_mb} MB.`, true);
  }
  escribir(CLAVE_CODIGO, codigo);
  const datos = new FormData();
  datos.append("video", archivo);
  datos.append("codigo", codigo);
  datos.append("modo", $("f-modo").value);
  datos.append("largo", $("f-largo").value || "15");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${SERVIDOR_ANALISIS}/trabajos`);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      pintar({ titulo: "Subiendo tu video…", texto: `${(e.loaded / 1e6).toFixed(1)} de ${(e.total / 1e6).toFixed(1)} MB`,
               avance: e.loaded / e.total });
    }
  };
  xhr.onload = () => {
    let r = {};
    try { r = JSON.parse(xhr.responseText); } catch { /* respuesta vacia */ }
    if (xhr.status === 200 && r.id) {
      escribir(CLAVE_TRABAJO, r.id);
      seguir(r.id);
    } else {
      pintarError(r.error || (xhr.status === 413 ? "El video es demasiado grande." : "El servidor no aceptó el video."),
                  xhr.status === 403);
    }
  };
  xhr.onerror = () => pintarError("Se cortó la conexión mientras se subía el video. Inténtalo de nuevo.");
  pintar({ titulo: "Subiendo tu video…", texto: "", avance: 0 });
  xhr.send(datos);
}

function pintarError(texto, volverAlFormulario = false) {
  if (volverAlFormulario) {
    mostrar("formulario");
    $("f-error").textContent = texto;
    $("f-error").hidden = false;
    return;
  }
  $("f-error").hidden = true;
  pintar({ titulo: "No se pudo analizar", texto, avance: null, nivel: "error" });
}

function seguir(id) {
  clearTimeout(sondeo);
  $("f-error").hidden = true;
  const paso = async () => {
    let e;
    try {
      e = await estadoTrabajo(id);
    } catch (err) {
      if (err.status === 404) { escribir(CLAVE_TRABAJO, null); sondeo = null; return pintarError(err.message); }
      sondeo = setTimeout(paso, 6000);                    // corte de internet: se reintenta
      return;
    }
    const etapa = ETAPAS[e.estado] || e.estado;
    if (e.estado === "listo") {
      escribir(CLAVE_TRABAJO, null);
      sondeo = null;
      pintar({ titulo: "¡Tu video está listo!", nivel: "ok", avance: 1, listo: true, id,
               texto: `${e.video} · ${e.camiones ?? "?"} camiones · analizado en ${mmss(e.segundos_analisis)}. ` +
                      "Se guarda 24 horas: puedes compartir el enlace de la página de resultados." });
      return;
    }
    if (e.estado === "error") {
      escribir(CLAVE_TRABAJO, null);
      sondeo = null;
      return pintarError(e.mensaje || "El análisis falló.");
    }
    let texto = e.mensaje || "";
    let avance = null;
    if (e.estado === "analizando") {
      avance = e.avance || 0;
      texto = `${Math.round(avance * 100)} %` + (e.falta_s ? ` · faltan ~${mmss(e.falta_s)}` : "");
    } else if (e.antes > 0) {
      texto = `Hay ${e.antes} ${e.antes === 1 ? "video" : "videos"} antes que el tuyo.`;
    } else if (e.estado === "en_cola") {
      texto = "El servidor se está encendiendo (puede tardar 1 o 2 minutos la primera vez).";
    }
    pintar({ titulo: `${etapa}…`, texto, avance });
    sondeo = setTimeout(paso, 3000);
  };
  pintar({ titulo: "Video recibido…", texto: "Empezando…", avance: null });
  paso();
}
