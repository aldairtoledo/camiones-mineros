// Excel del visitante: arma, con SUS zonas, limites y periodo, el mismo diccionario que la app de
// escritorio le entrega a reporte_excel.generar() (RegistroDatos._datos_reporte), y lo convierte
// en Excel dentro del navegador (excel_worker.js). Nada se envia a ningun servidor.
import { calcularResultados } from "./resultados.js";

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const hmsLargo = (s) => {                                 // str(timedelta(seconds=int(s)))
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const g = (v) => (Number.isInteger(v) ? v : Math.round(v * 100) / 100);

/** Diccionario para reporte_excel.generar (mismas claves y reglas que RegistroDatos). */
export function datosParaExcel({ demo, tablero, res, avisos, zonas, limiteGeneral, hasta, georef }) {
  const R = calcularResultados({ demo, tablero, res, avisos, zonas, limiteGeneral, hasta });
  const X = R.excel;
  const tipo = (z) => zonas[z].tipo.toUpperCase();

  // Eventos de zona (RegistroDatos._eventos_finales): entradas, salidas y los que siguen dentro.
  const abierta = new Map();
  const eventos = X.eventos.map((e) => {
    const k = `${e.pid}|${e.z}`;
    let perm = null;
    if (e.tipo === "ENTRADA") abierta.set(k, e.t);
    else if (abierta.has(k)) { perm = r2(e.t - abierta.get(k)); abierta.delete(k); }
    return { tiempo_s: r2(e.t), tiempo_hms: hmsLargo(e.t), frame: Math.round(e.t * demo.fps), id_camion: e.pid,
             zona: `Z${e.z + 1}`, nombre_zona: X.nombreZona(e.z), tipo_zona: tipo(e.z), zona_id_interno: e.z,
             evento: e.tipo, permanencia_s: perm, contado_en_panel: e.tipo === "ENTRADA" ? "SI" : "-" };
  });
  const siguen = [...X.abiertas].map(([k, t0]) => k.split("|").map(Number).concat(t0))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [pid, z, t0] of siguen) {
    eventos.push({ tiempo_s: r2(X.tFinal), tiempo_hms: hmsLargo(X.tFinal), frame: Math.round(X.tFinal * demo.fps),
                   id_camion: pid, zona: `Z${z + 1}`, nombre_zona: X.nombreZona(z), tipo_zona: tipo(z),
                   evento: "SIGUE_DENTRO_AL_FINAL", permanencia_s: r2(X.tFinal - t0), contado_en_panel: "-" });
  }

  // Ocupacion de cada zona en cada muestra (RegistroDatos.ocupacion)
  const ocupacion = [];
  for (const m of X.muestras) m.ocupacion.forEach((n, z) => ocupacion.push({ tiempo_s: m.t, zona: `Z${z + 1}`, camiones: n }));

  // Camiones y zonas: los mismos de la pestana Resultados (ya validados contra Python).
  const quitar = ["como", "salio", "n_detenciones", "detencion_mas_larga_s"];
  const camiones = R.camiones.map((c) => {
    const f = { ...c };
    for (const k of quitar) delete f[k];
    for (const k of ["primera_aparicion_s", "ultima_aparicion_s", "tiempo_visible_s", "tiempo_detenido_s", "tiempo_en_movimiento_s"]) f[k] = r2(f[k]);
    return f;
  });
  const zonasRes = R.zonas.map((z) => ({
    zona: z.zona, nombre_zona: z.nombre_zona, tipo: z.tipo.toUpperCase(), entradas_totales: z.entradas_totales,
    pasadas_contadas_en_panel: z.entradas_totales, camiones_por_hora: z.camiones_por_hora,
    permanencia_prom_s: r2(z.permanencia_prom_s), permanencia_min_s: r2(z.permanencia_min_s),
    permanencia_max_s: r2(z.permanencia_max_s), ocupacion_promedio: z.ocupacion_promedio, ocupacion_maxima: z.ocupacion_maxima,
  }));

  const datos = {
    video: tablero.video, duracion_s: R.completo ? tablero.duracion_s : R.T, fps: demo.fps, resolucion: demo.resolucion,
    camiones, zonas: zonasRes, eventos, alertas: X.avisos, trayectorias: R.tray, ocupacion,
    nombres_zonas: zonas.map((_, z) => X.nombreZona(z)), tipos_zonas: zonas.map((z) => z.tipo),
    intervalo: tablero.intervalo || 0.5, limite_general: limiteGeneral || null,
  };

  // Parametros: los del analisis, con el periodo, las zonas y los limites de este visitante.
  const fuera = /^(Fecha de exportacion|Video|Duracion procesada|Frames procesados|Limite de velocidad)/;
  const base = (tablero.parametros || []).filter(([k]) => !fuera.test(k));
  const ahora = new Date();
  const fecha = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}-${String(ahora.getDate()).padStart(2, "0")} ` +
                `${String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}`;
  const parametros = [
    ["Fecha de exportacion", fecha],
    ["Video", tablero.video],
    ["Duracion procesada", hmsLargo(datos.duracion_s)],
    ["Frames procesados", Math.floor(datos.duracion_s * demo.fps + 1e-6)],
    ["Origen del reporte", "pagina web (modo demostracion): zonas, limites y periodo elegidos por el visitante"],
    ["Periodo analizado", R.completo ? "todo el video" : `primeros ${hmsLargo(R.T)} (hasta el directo)`],
    ...base,
    ["Limite de velocidad general (km/h)", limiteGeneral ? g(limiteGeneral) : "sin limite"],
    ...zonas.map((z, i) => (z.limite ? [`Limite de velocidad en ${X.nombreZona(i)} (km/h)`, g(z.limite)] : null)).filter(Boolean),
  ];
  return { datos, parametros, calibracion: tablero.calibracion || null, escala_m_px: georef ? georef.escalaMPx : null,
           T: R.T, completo: R.completo };
}

// ---------------------------------------------------------------- generacion en segundo plano
let trabajador = null, siguienteId = 1;
const pendientes = new Map();

function obtenerTrabajador() {
  if (!trabajador) {
    trabajador = new Worker("js/excel_worker.js");
    trabajador.onmessage = (e) => {
      const p = pendientes.get(e.data.id);
      if (!p) return;
      if (e.data.paso) { p.alAvanzar?.(e.data.paso); return; }
      pendientes.delete(e.data.id);
      if (e.data.error) p.mal(new Error(e.data.error)); else p.ok(e.data.bytes);
    };
    trabajador.onerror = (e) => {
      for (const p of pendientes.values()) p.mal(new Error(e.message || "No se pudo iniciar el generador de Excel."));
      pendientes.clear();
      trabajador = null;
    };
  }
  return trabajador;
}

/** Devuelve un Blob con el Excel. alAvanzar(texto) informa en que paso va. */
export function generarExcel(entrada, alAvanzar) {
  const texto = JSON.stringify(entrada, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v));
  return new Promise((ok, mal) => {
    const id = siguienteId++;
    pendientes.set(id, { ok, mal, alAvanzar });
    obtenerTrabajador().postMessage({ id, texto, urlReporte: new URL("py/reporte_excel.py", location.href).href });
  }).then((bytes) => new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}
