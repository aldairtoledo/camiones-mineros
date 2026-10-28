// Vista "Resultados": tarjetas, hallazgos, flujo del circuito, graficas, mapa y tablas.
// Cada grafica responde una pregunta, dice como leerla y escribe su conclusion en palabras simples.
import { calcularResultados, hms, ROLES } from "./resultados.js";

const SERIE = { mov: "#3987e5", det: "#d95926", detFuera: "#9085e9", unica: "#3987e5", avisos: "#199e70" };
// Paleta categorica validada para fondo oscuro (orden fijo, nunca ciclado).
const CATEGORICA = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const COLOR_ZONA = { acumulativa: "#FF8000", dinamica: "#FF00FF" };
const TXT = { primario: "#E8EAED", suave: "#9AA3AE", tenue: "#6B7480", grilla: "rgba(255,255,255,.07)", eje: "#3A4250",
              panel: "#1A1E25", tarjeta: "#222731" };
const LETRA = "IBM Plex Sans, Segoe UI, system-ui, sans-serif";

const $ = (id) => document.getElementById(id);
const miles = (v, dec = 0) => {
  const [e, d] = Math.abs(v).toFixed(dec).split(".");
  return (v < 0 ? "-" : "") + e.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (d ? "." + d : "");
};
const min = (s) => s / 60;
const pct = (v) => `${Math.round(v * 100)} %`;
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let echartsListo = null;
function cargarECharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (!echartsListo) {
    echartsListo = new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = "js/vendor/echarts.min.js";
      s.onload = () => ok(window.echarts);
      s.onerror = mal;
      document.head.appendChild(s);
    });
  }
  return echartsListo;
}

const ESTADO = { tablero: null, cargando: null, corte: "todo", tabla: "camiones", graficas: [], R: null, ctx: null,
                 mapaCamion: "todos" };

export async function mostrarResultados(ctx, corteInicial) {
  ESTADO.ctx = ctx;
  if (corteInicial) ESTADO.corte = corteInicial;
  const raiz = $("vista-resultados");
  if (!ESTADO.tablero || !window.echarts) {       // el tablero puede venir ya cargado por el Excel
    $("res-kpis").innerHTML = '<p class="cargando-res">Preparando los resultados…</p>';
    try {
      await Promise.all([cargarTablero(ctx.base), cargarECharts()]);
    } catch {
      $("res-kpis").innerHTML = '<p class="vacio">No se encontraron los datos de resultados (resultados.json). Vuelve a correr exportar_demo.py en la laptop.</p>';
      return;
    }
  }
  if (raiz.hidden) return;                       // el usuario ya volvio a Monitoreo
  pintar();
}

/** Datos del dashboard (resultados.json); los usa tambien el Excel del visitante. */
let ajustarTablero = (t) => t;
/** fn(tablero) se aplica al tablero recien cargado (por ejemplo, la calibracion del visitante). */
export function alCargarTablero(fn) { ajustarTablero = fn; }
export const tableroCargado = () => ESTADO.tablero;

export function cargarTablero(base) {
  if (ESTADO.tablero) return Promise.resolve(ESTADO.tablero);
  ESTADO.cargando = ESTADO.cargando || fetch(base + "resultados.json")
    .then((r) => { if (!r.ok) throw new Error("sin resultados.json"); return r.json(); })
    .catch((e) => { ESTADO.cargando = null; throw e; });
  return ESTADO.cargando.then((t) => { ajustarTablero(t); return (ESTADO.tablero = t); });
}
export const corteResultados = () => ESTADO.corte;

export function redimensionarResultados() {
  for (const g of ESTADO.graficas) g.resize();
  if (ESTADO.R) dibujarMapa();
}

// ---------------------------------------------------------------- pintar todo
function pintar() {
  const ctx = ESTADO.ctx, E = ctx.E;
  const dur = E.demo.duracion_s;
  const hayDirecto = E.iniciado && E.vivo < dur - 0.5;
  if (!hayDirecto) ESTADO.corte = "todo";
  const bDirecto = $("b-corte-directo");
  $("seg-corte").hidden = !hayDirecto;          // si no hay "directo", solo existe "todo el video"
  bDirecto.textContent = `Hasta ${hms(E.vivo)} (directo)`;
  document.querySelectorAll("#seg-corte button").forEach((b) => {
    const activo = b.dataset.corte === ESTADO.corte;
    b.classList.toggle("activo", activo);
    b.setAttribute("aria-checked", String(activo));
  });
  const hasta = ESTADO.corte === "directo" ? E.vivo : null;
  const R = calcularResultados({ demo: E.demo, tablero: ESTADO.tablero, res: E.res, avisos: E.avisos, zonas: E.zonas,
                                 limiteGeneral: E.limiteGeneral, hasta });
  ESTADO.R = R;
  const geo = E.georef;
  const calib = !geo ? "sin calibrar (medidas en píxeles)"
    : !geo.esPlano() ? "con puntos UTM (Este, Norte)"
    : String(geo.info.fuente || "").startsWith("Solo camión") || String(geo.info.fuente || "").startsWith("Automática")
      ? `aproximada con el tamaño del camión (± ${geo.info.incertidumbre_escala_pct ?? 7} %)` : "en metros";
  $("res-sub").textContent = `${E.demo.video} · ${R.completo ? `todo el video (${hms(dur)})` : `primeros ${hms(R.T)} de ${hms(dur)}`} · calibración ${calib}`;
  const notas = [];
  if (!E.iniciado) notas.push("Todavía no iniciaste el video, así que ves el resumen del análisis completo.");
  if (E.cambiado) notas.push("Estos resultados usan tus zonas, límites y calibración. El botón Exportar a Excel arma tu Excel con ellos.");
  $("res-nota").hidden = !notas.length;
  $("res-nota").textContent = notas.join(" ");
  pintarKpis(R);
  $("res-hallazgos").innerHTML = R.hallazgos.map((h) => `<li>${esc(h)}</li>`).join("");
  pintarFlujo(R);
  pintarGraficas(R);
  pintarTabla();
  pintarGlosario();
}

// ---------------------------------------------------------------- tarjetas
function pintarKpis(R) {
  const k = R.kpis;
  const tarjetas = [
    ["Camiones analizados", `${k.camiones}`, "", `en ${hms(R.T)} de video`, "Cantidad de camiones distintos que se vieron."],
    ["Distancia total", miles(k.distancia), k.unidad, "suma de todos los camiones", "Lo que recorrieron todos los camiones juntos."],
    ["Velocidad media", k.velocidad_media.toFixed(1), k.unidad_v, "sin contar el tiempo detenido", "Distancia recorrida ÷ tiempo en movimiento."],
    ["Tiempo detenido", pct(k.pct_detenido), "", "del tiempo total observado", "Parte del tiempo en que los camiones no avanzaban."],
    ["Detenciones", `${k.detenciones}`, "", `paradas de ${ESTADO.tablero.detencion_minima_s ?? 5} s o más`, "Cada vez que un camión estuvo parado un buen rato."],
    k.camiones && R.metros ? ["Excesos de velocidad", `${k.excesos}`, "", ESTADO.ctx.E.limiteGeneral ? `límite general ${ESTADO.ctx.E.limiteGeneral} km/h` : "según los límites definidos", "Veces que un camión superó el límite durante 1 s o más."]
      : ["Zonas de control", `${k.zonas}`, "", "definidas en el video", "Áreas dibujadas para contar camiones."],
  ];
  $("res-kpis").innerHTML = tarjetas.map(([e, v, u, n, ayuda], i) =>
    `<div class="kpi${i === 5 && k.excesos ? " alerta" : ""}" title="${esc(ayuda)}"><div class="etq">${e}</div>` +
    `<div class="val">${v}${u ? `<small>${u}</small>` : ""}</div><p class="nota">${n}</p></div>`).join("");
}

// ---------------------------------------------------------------- flujo del circuito
const ICONOS_ETAPA = {
  via: '<path d="M4 20 9 4M20 20 15 4M12 6v2M12 11v2M12 16v2"/>',
  cola: '<rect x="2" y="13" width="5" height="4" rx="1"/><rect x="9.5" y="13" width="5" height="4" rx="1"/><rect x="17" y="13" width="5" height="4" rx="1"/><path d="M3 9h18m-3-3 3 3-3 3"/>',
  carguio: '<path d="M3 18h10l2-5H6zM15 13l3-6 3 2-2 5M5 21h1m6 0h1"/>',
  chancadora: '<path d="M4 4h16l-3 8H7zM7 12v4m10-4v4M5 20h14M9 8h6"/>',
};
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const DESCRIPCION_ETAPA = {
  via: (e) => `${plural(e.entradas, "pasada", "pasadas")} · máx. ${e.maximo_a_la_vez} a la vez`,
  cola: (e) => `${plural(e.entradas, "camión hizo cola", "camiones hicieron cola")} · máx. ${e.maximo_a_la_vez} a la vez`,
  carguio: (e) => `${plural(e.entradas, "entrada", "entradas")} a carguío · máx. ${e.maximo_a_la_vez} a la vez`,
  chancadora: (e) => `${plural(e.entradas, "descarga", "descargas")} · máx. ${e.maximo_a_la_vez} a la vez`,
};
// Se nombran las zonas solo si dicen algo mas que el nombre de la etapa.
const zonasEtapa = (e) => (e.zonas.length === 1 && e.zonas[0].toLowerCase() === ROLES[e.rol].toLowerCase() ? "" : `${e.zonas.join(", ")} · `);
const NOMBRE_TIEMPO = { via: "en el tramo", cola: "de espera", carguio: "de carguío", chancadora: "de descarga" };

function pintarFlujo(R) {
  const caja = $("res-flujo");
  if (!R.flujo.length) {
    caja.innerHTML = `<div class="vacio">Para ver el flujo, indica qué papel cumple cada zona (Vía, Cola, Carguío o Chancadora): en
      <b>Monitoreo</b>, toca el ✎ de la tarjeta de la zona y elige "Esta zona es".<br>
      <button class="boton" id="b-ir-zonas">Ir a Monitoreo</button></div>`;
    $("b-ir-zonas").onclick = () => ESTADO.ctx.irMonitoreo();
    return;
  }
  const conTiempo = R.flujo.filter((e) => e.tiempo_prom_s != null);
  const lenta = conTiempo.length > 1 ? conTiempo.reduce((m, e) => (e.tiempo_prom_s > m.tiempo_prom_s ? e : m)) : null;
  caja.innerHTML = '<div class="flujo">' + R.flujo.map((e, i) => `
    ${i ? '<div class="flecha-etapa" aria-hidden="true"></div>' : ""}
    <div class="etapa${lenta && e.rol === lenta.rol ? " lenta" : ""}">
      <div class="icono-etapa"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONOS_ETAPA[e.rol]}</svg></div>
      <div><div class="nom">${ROLES[e.rol]}</div><div class="det">${esc(zonasEtapa(e))}${DESCRIPCION_ETAPA[e.rol](e)}</div></div>
      <div class="cifras"><b>${e.tiempo_prom_s != null ? hms(e.tiempo_prom_s) : "—"}</b><span>promedio ${NOMBRE_TIEMPO[e.rol]}</span></div>
    </div>`).join("") + "</div>" +
    (lenta ? `<p class="lenta-nota">La etapa donde los camiones pasan más tiempo es <b>${ROLES[lenta.rol]}</b> (${hms(lenta.tiempo_prom_s)} en promedio). Ahí conviene mirar primero para mejorar el ciclo.</p>` : "");
}

// ---------------------------------------------------------------- graficas
function baseGrafica() {
  return {
    textStyle: { fontFamily: LETRA, color: TXT.suave },
    animationDuration: 500,
    tooltip: { backgroundColor: TXT.tarjeta, borderColor: "#2E3440", textStyle: { color: TXT.primario, fontFamily: LETRA, fontSize: 12 },
               extraCssText: "border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.35);" },
    grid: { left: 8, right: 24, top: 52, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, textStyle: { color: TXT.primario, fontSize: 12 }, itemWidth: 12, itemHeight: 12, icon: "roundRect" },
  };
}
// En el eje horizontal el nombre va centrado debajo (al final se cortaria); en el vertical, arriba.
const ejeValor = (nombre, horizontal = false) => ({ type: "value", name: nombre, nameTextStyle: { color: TXT.tenue, fontSize: 11 },
  ...(horizontal ? { nameLocation: "middle", nameGap: 26 } : {}),
  axisLabel: { color: TXT.suave, fontSize: 11 }, splitLine: { lineStyle: { color: TXT.grilla } }, axisLine: { show: false } });
const ejeCategoria = (datos) => ({ type: "category", data: datos, axisLabel: { color: TXT.suave, fontSize: 11 },
  axisLine: { lineStyle: { color: TXT.eje } }, axisTick: { show: false } });

function tarjetaGrafica(id, titulo, como, ancha = false) {
  return `<article class="tarjeta-res grafica${ancha ? " ancha" : ""}"><h3>${titulo}</h3>
    <p class="como"><strong>Cómo leerla:</strong> ${como}</p><div class="lienzo" id="${id}" role="img" aria-label="${esc(titulo)}"></div>
    <p class="conclusion" id="${id}-c"></p></article>`;
}

function pintarGraficas(R) {
  for (const g of ESTADO.graficas) g.dispose();
  ESTADO.graficas = [];
  const cont = $("res-graficas");
  cont.innerHTML =
    tarjetaGrafica("g-tiempos", "¿Cuánto tiempo estuvo cada camión en movimiento y detenido?",
      "cada barra es un camión. La parte <b style='color:#3987e5'>azul</b> es el tiempo que avanzaba y la <b style='color:#d95926'>naranja</b>, el tiempo que estuvo parado (en minutos).") +
    tarjetaGrafica("g-reparto", "¿En qué se fue el tiempo de la flota?",
      "el círculo completo es todo el tiempo que se vieron los camiones. Cada parte muestra qué porcentaje pasaron avanzando o detenidos.") +
    tarjetaGrafica("g-distancia", "¿Cuánta distancia recorrió cada camión?",
      `cada barra es un camión; mientras más alta, más ${R.metros ? "metros" : "píxeles"} recorrió.`) +
    tarjetaGrafica("g-avisos", "¿Qué avisos ocurrieron y cuántas veces?",
      "cada barra es un tipo de aviso que dio el sistema durante el video; el número indica cuántas veces ocurrió.") +
    tarjetaGrafica("g-ocupacion", "¿Cuántos camiones había en cada zona a lo largo del video?",
      `cada línea es una zona. Sube cuando entran camiones y baja cuando salen (promedio cada ${R.paso} s). Una línea alta y plana indica que se formó cola.`, true) +
    `<article class="tarjeta-res grafica ancha"><h3>¿Por dónde se movieron los camiones?</h3>
      <p class="como"><strong>Cómo leerla:</strong> es el video visto desde arriba. Cada línea es el camino que siguió un camión y el número marca dónde se le vio por última vez. Elige un camión para resaltarlo.</p>
      <div class="chips" id="mapa-chips"></div>
      <div class="mapa-envoltura"><canvas id="mapa"></canvas></div>
      <p class="conclusion" id="mapa-c"></p></article>`;

  const echarts = window.echarts;
  const nuevo = (id, op) => { const g = echarts.init($(id), null, { renderer: "canvas" }); g.setOption(op); ESTADO.graficas.push(g); return g; };
  const cam = R.camiones;
  const nombres = cam.map((c) => `Camión ${c.id_camion}`);

  // 1) movimiento vs detenido (barras horizontales apiladas)
  if (cam.length) {
    nuevo("g-tiempos", { ...baseGrafica(),
      tooltip: { ...baseGrafica().tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(255,255,255,.04)" } },
        formatter: (p) => { const c = cam[p[0].dataIndex]; return `<b>${nombres[p[0].dataIndex]}</b><br>` +
          `<span style="color:${SERIE.mov}">■</span> En movimiento: ${hms(c.tiempo_en_movimiento_s)}<br>` +
          `<span style="color:${SERIE.det}">■</span> Detenido: ${hms(c.tiempo_detenido_s)} (${Math.round(c.porcentaje_detenido)} %)`; } },
      grid: { ...baseGrafica().grid, top: 36, bottom: 28 },
      xAxis: ejeValor("minutos", true), yAxis: { ...ejeCategoria(nombres), inverse: true },
      series: [
        { name: "En movimiento", type: "bar", stack: "t", barMaxWidth: 22, itemStyle: { color: SERIE.mov, borderColor: TXT.panel, borderWidth: 1 },
          data: cam.map((c) => +min(c.tiempo_en_movimiento_s).toFixed(2)) },
        { name: "Detenido", type: "bar", stack: "t", barMaxWidth: 22, itemStyle: { color: SERIE.det, borderColor: TXT.panel, borderWidth: 1, borderRadius: [0, 4, 4, 0] },
          data: cam.map((c) => +min(c.tiempo_detenido_s).toFixed(2)) },
      ] });
    const peor = cam.reduce((m, c) => (c.tiempo_detenido_s > m.tiempo_detenido_s ? c : m));
    const mejor = cam.reduce((m, c) => (c.tiempo_en_movimiento_s > m.tiempo_en_movimiento_s ? c : m));
    $("g-tiempos-c").innerHTML = `<b>En resumen:</b> el camión ${peor.id_camion} fue el que más tiempo estuvo detenido (${hms(peor.tiempo_detenido_s)}) y el camión ${mejor.id_camion}, el que más tiempo avanzó (${hms(mejor.tiempo_en_movimiento_s)}).`;
  }

  // 2) dona del tiempo de la flota
  const colores = { "En movimiento": SERIE.mov, "Detenido en una zona": SERIE.det, "Detenido fuera de zonas": SERIE.detFuera };
  const rep = R.reparto.filter(([, v]) => v > 0);
  const total = rep.reduce((s, [, v]) => s + v, 0);
  nuevo("g-reparto", { ...baseGrafica(),
    tooltip: { ...baseGrafica().tooltip, trigger: "item", formatter: (p) => `<b>${p.name}</b><br>${hms(p.value)} · ${Math.round(p.percent)} %` },
    legend: { ...baseGrafica().legend, top: "auto", bottom: 0, left: "center" },
    graphic: [{ type: "text", left: "center", top: "40%", style: { text: hms(total), fill: TXT.primario, font: `600 22px ${LETRA}`, align: "center" } },
              { type: "text", left: "center", top: "51%", style: { text: "tiempo observado", fill: TXT.suave, font: `12px ${LETRA}`, align: "center" } }],
    series: [{ type: "pie", radius: ["48%", "70%"], center: ["50%", "46%"], padAngle: 1.2, itemStyle: { borderRadius: 4, borderColor: TXT.panel, borderWidth: 2 },
      label: { color: TXT.primario, formatter: (p) => `${Math.round(p.percent)} %`, fontSize: 13, fontWeight: 600 },
      labelLine: { lineStyle: { color: TXT.tenue } },
      data: rep.map(([n, v]) => ({ name: n, value: +v.toFixed(1), itemStyle: { color: colores[n] } })) }] });
  const pMov = total ? R.reparto[0][1] / total : 0;
  $("g-reparto-c").innerHTML = `<b>En resumen:</b> la flota estuvo en movimiento el ${Math.round(pMov * 100)} % del tiempo y detenida el ${Math.round((1 - pMov) * 100)} %` +
    (R.reparto[1][1] > R.reparto[2][1] ? ", sobre todo dentro de las zonas (por ejemplo, esperando o cargando)." : ", sobre todo fuera de las zonas.");

  // 3) distancia por camion
  if (cam.length) {
    const clave = R.metros ? "distancia_m" : "distancia_px", u = R.metros ? "m" : "px";
    nuevo("g-distancia", { ...baseGrafica(), legend: { show: false },
      tooltip: { ...baseGrafica().tooltip, trigger: "item", formatter: (p) => `<b>${p.name}</b><br>${miles(p.value)} ${u}` },
      xAxis: ejeCategoria(nombres), yAxis: ejeValor(R.metros ? "metros" : "píxeles"),
      series: [{ type: "bar", barMaxWidth: 36, itemStyle: { color: SERIE.unica, borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: "top", color: TXT.primario, fontSize: 11, formatter: (p) => miles(p.value) },
        data: cam.map((c) => Math.round(c[clave] || 0)) }] });
    const lejos = cam.reduce((m, c) => ((c[clave] || 0) > (m[clave] || 0) ? c : m));
    const tot = cam.reduce((s, c) => s + (c[clave] || 0), 0);
    $("g-distancia-c").innerHTML = `<b>En resumen:</b> el camión ${lejos.id_camion} recorrió más (${miles(lejos[clave] || 0)} ${u}), el ${tot ? Math.round(100 * (lejos[clave] || 0) / tot) : 0} % de toda la distancia de la flota.`;
  }

  // 4) avisos por tipo
  const av = [...R.conteoAvisos].sort((a, b) => a[1] - b[1]);
  nuevo("g-avisos", { ...baseGrafica(), legend: { show: false },
    tooltip: { ...baseGrafica().tooltip, trigger: "item", formatter: (p) => `<b>${p.name}</b><br>${p.value} ${p.value === 1 ? "vez" : "veces"}` },
    grid: { ...baseGrafica().grid, top: 12, bottom: 28 },
    xAxis: { ...ejeValor("veces", true), minInterval: 1 }, yAxis: ejeCategoria(av.map(([k]) => k)),
    series: [{ type: "bar", barMaxWidth: 20, itemStyle: { color: SERIE.avisos, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: "right", color: TXT.primario, fontSize: 11 }, data: av.map(([, v]) => v) }] });
  $("g-avisos-c").innerHTML = av.length ? `<b>En resumen:</b> hubo ${av.reduce((s, [, v]) => s + v, 0)} avisos. El más frecuente fue "${av[av.length - 1][0]}" (${av[av.length - 1][1]} veces).`
    : "<b>En resumen:</b> no hubo avisos en este periodo.";

  // 5) ocupacion de zonas en el tiempo
  const E = ESTADO.ctx.E;
  if (E.zonas.length && R.ocupacion.length) {
    nuevo("g-ocupacion", { ...baseGrafica(),
      tooltip: { ...baseGrafica().tooltip, trigger: "axis", valueFormatter: (v) => `${(+v).toFixed(1)} camiones` },
      xAxis: { ...ejeCategoria(R.ocupacion.map((o) => hms(o.desde))), boundaryGap: false, name: "tiempo del video", nameLocation: "middle", nameGap: 28,
               nameTextStyle: { color: TXT.tenue, fontSize: 11 } },
      grid: { ...baseGrafica().grid, top: 60, bottom: 30 },
      yAxis: { ...ejeValor(""), minInterval: 1 },
      series: R.zonas.map((z, i) => ({ name: z.nombre_zona, type: "line", step: "middle", symbol: "none", lineStyle: { width: 2 },
        color: CATEGORICA[i % CATEGORICA.length], data: R.ocupacion.map((o) => +o.promedio[i].toFixed(2)) })) });
    const z = R.zonas.reduce((m, x) => ((x.ocupacion_maxima || 0) > (m.ocupacion_maxima || 0) ? x : m));
    $("g-ocupacion-c").innerHTML = `<b>En resumen:</b> la zona más llena fue ${esc(z.nombre_zona)}, con hasta ${plural(z.ocupacion_maxima || 0, "camión", "camiones")} a la vez (en promedio ${(z.ocupacion_promedio || 0).toFixed(1)}).`;
  } else {
    $("g-ocupacion").outerHTML = '<div class="vacio">Dibuja zonas en Monitoreo para ver cuántos camiones hubo en cada una a lo largo del video.</div>';
    $("g-ocupacion-c").remove();
  }

  // 6) mapa de recorridos
  const chips = $("mapa-chips");
  const ids = [...new Set(R.tray.map((f) => f.id_camion))].sort((a, b) => a - b);
  if (ESTADO.mapaCamion !== "todos" && !ids.includes(ESTADO.mapaCamion)) ESTADO.mapaCamion = "todos";
  chips.innerHTML = [["todos", "Todos"], ...ids.map((i) => [i, `Camión ${i}`])].map(([v, t]) =>
    `<button class="chip" data-v="${v}" aria-pressed="${String(v) === String(ESTADO.mapaCamion)}">${t}</button>`).join("");
  chips.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    ESTADO.mapaCamion = b.dataset.v === "todos" ? "todos" : Number(b.dataset.v);
    chips.querySelectorAll("button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    dibujarMapa();
  }));
  dibujarMapa();
}

function dibujarMapa() {
  const R = ESTADO.R, E = ESTADO.ctx.E, cv = $("mapa");
  if (!cv || !R) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const video = ESTADO.ctx.video;
  try { if (video.readyState >= 2) c.drawImage(video, 0, 0, W, H); } catch { /* sin imagen */ }
  c.fillStyle = "rgba(10,12,16,.45)";
  c.fillRect(0, 0, W, H);
  const [RW, RH] = E.demo.resolucion, [AW, AH] = E.demo.trabajo;
  const px = (x, y) => [x / RW * W, y / RH * H];              // pixeles originales
  const pz = (x, y) => [x / AW * W, y / AH * H];              // cuadro de trabajo (zonas)
  E.zonas.forEach((z) => {
    c.beginPath();
    z.puntos.forEach(([x, y], i) => { const [a, b] = pz(x, y); i ? c.lineTo(a, b) : c.moveTo(a, b); });
    c.closePath();
    c.fillStyle = COLOR_ZONA[z.tipo] + "22"; c.fill();
    c.setLineDash([8, 5]); c.lineWidth = 1.5; c.strokeStyle = COLOR_ZONA[z.tipo]; c.stroke(); c.setLineDash([]);
  });
  const porCamion = new Map();
  for (const f of R.tray) (porCamion.get(f.id_camion) || porCamion.set(f.id_camion, []).get(f.id_camion)).push(f);
  const sel = ESTADO.mapaCamion;
  const trazar = (filas, color, ancho) => {
    c.beginPath();
    let anterior = null;
    for (const f of filas) {
      const [a, b] = px(f.centro_x, f.centro_y);
      if (anterior == null || f.tiempo_s - anterior > 2.5) c.moveTo(a, b); else c.lineTo(a, b);   // si no se vio un rato, se corta
      anterior = f.tiempo_s;
    }
    c.strokeStyle = color; c.lineWidth = ancho; c.lineJoin = "round"; c.lineCap = "round"; c.stroke();
  };
  for (const [pid, filas] of porCamion) {
    const resaltado = sel === "todos" || sel === pid;
    trazar(filas, resaltado ? (sel === "todos" ? "rgba(232,234,237,.85)" : "#3987e5") : "rgba(232,234,237,.18)", resaltado && sel !== "todos" ? 3 : 1.6);
  }
  c.font = `600 11px ${LETRA}`; c.textAlign = "center"; c.textBaseline = "middle";
  for (const [pid, filas] of porCamion) {
    if (sel !== "todos" && sel !== pid) continue;
    const f = filas[filas.length - 1];
    const [a, b] = px(f.centro_x, f.centro_y);
    const t = String(pid), w = c.measureText(t).width + 10;
    c.fillStyle = sel === "todos" ? "#00FFFF" : "#3987e5";
    c.fillRect(a - w / 2, b - 8, w, 16);
    c.fillStyle = "#000"; c.fillText(t, a, b + 0.5);
  }
  let texto;
  if (sel === "todos") texto = `<b>En resumen:</b> se ven los caminos de ${porCamion.size} camiones. Las zonas punteadas son las áreas de control.`;
  else {
    const cam = R.camiones.find((x) => x.id_camion === sel);
    texto = cam ? `<b>Camión ${sel}:</b> recorrió ${miles(R.metros ? cam.distancia_m || 0 : cam.distancia_px || 0)} ${R.metros ? "m" : "px"}, estuvo detenido el ${Math.round(cam.porcentaje_detenido)} % del tiempo y tuvo ${cam.n_detenciones} detenciones.` : "";
  }
  $("mapa-c").innerHTML = texto;
}

// ---------------------------------------------------------------- tablas
const AYUDA_TABLA = {
  camiones: "Una fila por camión. Toca una fila para ver ese camión en el video. La última fila resume toda la flota.",
  detenciones: "Cada vez que un camión estuvo parado 5 s o más. Toca una fila para ver ese momento en el video.",
  zonas: "Cómo se usó cada zona: cuántos camiones entraron, cuánto tiempo se quedaron y cuántos hubo a la vez.",
  bitacora: "Todo lo que pasó, en orden de tiempo. Toca una fila para ver ese momento en el video.",
};
export function elegirTabla(nombre) {
  ESTADO.tabla = nombre;
  document.querySelectorAll("#seg-tabla button").forEach((b) => {
    b.classList.toggle("activo", b.dataset.tabla === nombre);
    b.setAttribute("aria-selected", String(b.dataset.tabla === nombre));
  });
  pintarTabla();
}
export function elegirCorte(corte) { ESTADO.corte = corte; pintar(); }

function pintarTabla() {
  const R = ESTADO.R, E = ESTADO.ctx.E, t = $("res-tabla");
  if (!R) return;
  $("res-tabla-ayuda").textContent = AYUDA_TABLA[ESTADO.tabla];
  let cab = [], filas = [], pie = null;
  const u = R.metros ? "m" : "px";
  if (ESTADO.tabla === "camiones") {
    cab = [["Camión"], ["Cómo apareció"], ["Primera vez", 1], ["Última vez", 1], ["Visible", 1], ["En movimiento", 1], ["Detenido", 1],
           ["% detenido", 1], ["Detenciones", 1], [`Distancia (${u})`, 1], [`Vel. media (${R.metros ? "km/h" : "px/s"})`, 1]];
    if (R.metros) cab.push(["Vel. máxima (km/h)", 1], ["Excesos", 1]);
    cab.push(["Salió de la imagen"]);
    filas = R.camiones.map((c) => ({ t: c.primera_aparicion_s, celdas: [
      `<b>${c.id_camion}</b>`, c.como, hms(c.primera_aparicion_s), hms(c.ultima_aparicion_s), hms(c.tiempo_visible_s),
      hms(c.tiempo_en_movimiento_s), hms(c.tiempo_detenido_s), `${Math.round(c.porcentaje_detenido)} %`, c.n_detenciones,
      miles(R.metros ? c.distancia_m || 0 : c.distancia_px || 0),
      c.tiempo_en_movimiento_s < (ESTADO.tablero.movimiento_minimo_vel_s ?? 3) ? "—" : (R.metros ? (c.velocidad_media_en_movimiento_km_h || 0).toFixed(1) : (c.distancia_px / c.tiempo_en_movimiento_s).toFixed(1)),
      ...(R.metros ? [(c.velocidad_maxima_km_h || 0).toFixed(1), c.veces_sobre_el_limite ? `<span class="pastilla alerta">${c.veces_sobre_el_limite}</span>` : "0"] : []),
      c.salio != null ? hms(c.salio) : "No"] }));
    const k = R.kpis;
    pie = ["Flota", "", "", "", hms(R.camiones.reduce((s, c) => s + c.tiempo_visible_s, 0)), hms(R.camiones.reduce((s, c) => s + c.tiempo_en_movimiento_s, 0)),
           hms(R.camiones.reduce((s, c) => s + c.tiempo_detenido_s, 0)), pct(k.pct_detenido), k.detenciones, miles(k.distancia), k.velocidad_media.toFixed(1),
           ...(R.metros ? [Math.max(0, ...R.camiones.map((c) => c.velocidad_maxima_km_h || 0)).toFixed(1), k.excesos] : []), ""];
  } else if (ESTADO.tabla === "detenciones") {
    cab = [["N.º", 1], ["Camión", 1], ["Inicio", 1], ["Fin", 1], ["Duración", 1], ["Lugar"], ["Observación"]];
    filas = R.detenciones.map((d, i) => ({ t: d.inicio, celdas: [i + 1, `<b>${d.camion}</b>`, hms(d.inicio), hms(d.fin), hms(d.duracion), esc(d.lugar),
      `<span class="suave">${esc(d.nota) || "—"}</span>`], texto: 6 }));
  } else if (ESTADO.tabla === "zonas") {
    cab = [["Zona"], ["Papel"], ["Tipo"], ["Qué mide"], ["Entradas", 1], ["Camiones por hora", 1], ["Permanencia prom.", 1],
           ["Mínima", 1], ["Máxima", 1], ["Ocupación prom.", 1], ["Ocupación máx.", 1]];
    filas = R.zonas.map((z) => ({ celdas: [`<span class="color-zona" style="background:${COLOR_ZONA[z.tipo]}"></span>${esc(z.nombre_zona)}`,
      z.rol ? ROLES[z.rol] : "—", z.tipo === "acumulativa" ? "Acumulativa" : "Dinámica",
      z.tipo === "acumulativa" ? "Cuenta los camiones que pasan" : "Cuenta los camiones que hay dentro", z.entradas_totales,
      z.camiones_por_hora.toFixed(1), z.permanencia_prom_s != null ? hms(z.permanencia_prom_s) : "—",
      z.permanencia_min_s != null ? hms(z.permanencia_min_s) : "—", z.permanencia_max_s != null ? hms(z.permanencia_max_s) : "—",
      z.ocupacion_promedio != null ? z.ocupacion_promedio.toFixed(1) : "—", z.ocupacion_maxima ?? "—"] }));
  } else {
    cab = [["Hora", 1], ["Camión", 1], ["Evento"], ["Zona"], ["Descripción"], ["Importancia"]];
    const nivel = { info: "Info", aviso: "Aviso", alerta: "Alerta" };
    filas = R.bitacora.map((b) => ({ t: b.t, celdas: [hms(b.t), b.camion ?? "—", esc(b.evento), esc(b.zona) || "—", esc(b.descripcion),
      `<span class="pastilla ${b.nivel}">${nivel[b.nivel] || "Info"}</span>`], texto: 4 }));
  }
  const num = cab.map((c) => !!c[1]);
  t.innerHTML = `<thead><tr>${cab.map(([n], i) => `<th class="${num[i] ? "num" : ""}" scope="col">${n}</th>`).join("")}</tr></thead>
    <tbody>${filas.length ? filas.map((f, i) => `<tr data-i="${i}" class="${f.t != null ? "clic" : ""}" ${f.t != null ? 'tabindex="0"' : ""}>${f.celdas.map((c, j) =>
      `<td class="${num[j] ? "num" : ""}${f.texto === j ? " texto" : ""}">${c}</td>`).join("")}</tr>`).join("")
      : `<tr><td colspan="${cab.length}" class="suave">Sin datos en este periodo.</td></tr>`}</tbody>
    ${pie ? `<tfoot><tr>${pie.map((c, j) => `<td class="${num[j] ? "num" : ""}">${c}</td>`).join("")}</tr></tfoot>` : ""}`;
  t.querySelectorAll("tbody tr.clic").forEach((tr) => {
    const ir = () => ESTADO.ctx.verMomento(filas[+tr.dataset.i].t);
    tr.addEventListener("click", ir);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") ir(); });
  });
}

function pintarGlosario() {
  const terminos = [
    ["Camión (N.º)", "Número que el sistema le da a cada camión al detectarlo. Si un camión sale por el borde y luego entra otro, el que entra recibe un número nuevo."],
    ["En movimiento / Detenido", "Detenido es cuando el camión prácticamente no avanza (solo se mueve un poco la caja de la detección)."],
    ["Detención", `Parada de ${ESTADO.tablero.detencion_minima_s ?? 5} s o más. Movimientos cortos, como acomodarse en la cola, no la cortan.`],
    ["Zona acumulativa", "Cuenta cuántos camiones pasaron por ella (por ejemplo, la descarga)."],
    ["Zona dinámica", "Cuenta cuántos camiones hay dentro en cada momento (por ejemplo, una cola)."],
    ["Permanencia", "Tiempo que un camión estuvo dentro de una zona en una visita."],
    ["Ocupación", "Cantidad de camiones dentro de una zona al mismo tiempo."],
    ["Velocidad media", "Distancia recorrida ÷ tiempo en movimiento. No cuenta el tiempo detenido."],
    ["Exceso de velocidad", "El camión superó el límite (general o de su zona) durante 1 s o más."],
    ["Posición estimada", "El camión estaba tapado o muy junto a otro, y su posición se calculó con su movimiento anterior."],
    ["Calibración", "Conversión de píxeles a metros. Con el tamaño del camión es aproximada (± 5–10 %); con distancias conocidas, precisa (± 1 %)."],
    ["Formato de tiempo", "minutos:segundos. Por ejemplo, 2:05 son 2 minutos y 5 segundos."],
  ];
  $("res-glosario").innerHTML = terminos.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
}
