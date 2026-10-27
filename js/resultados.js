// Calcula los resultados del dashboard en el navegador, con las MISMAS reglas que
// reporte_excel.py (_Datos, _hallazgos, ocupacion por intervalos) y que RegistroDatos
// (_resumen_camiones, _resumen_zonas). Se puede pedir "hasta" un momento del video y con las
// zonas que dibujo cada visitante.

export const TIPOS_AVISO = {
  DETENIDO: "Detención", ARRANQUE: "Arranque", PASO_CERCANO: "Paso cercano", PASO_CERCA_COLA: "Paso junto a la cola",
  ENTRADA_ZONA: "Entrada a zona", SALIDA_PANTALLA: "Salida de la imagen", ENTRADA_PANTALLA: "Ingreso a la imagen",
  ACERCAMIENTO: "Acercamiento a zona", CURVA: "Curva", REGRESO: "Regreso", RETROCESO: "Retroceso",
  GIRO_180: "Giro en U", EXCESO_VELOCIDAD: "Exceso de velocidad",
};
export const ROLES = { via: "Vía", cola: "Cola", carguio: "Carguío", chancadora: "Chancadora" };
export const ORDEN_ROLES = ["via", "cola", "carguio", "chancadora"];

export function hms(segundos) {                // _hms de reporte_excel.py
  const s = Math.round(segundos || 0);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const f0 = (v) => Number(v || 0).toFixed(0);
const miles0 = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * demo: demo.json · tablero: resultados.json · res: resultado de recalcular() · avisos: avisos vigentes
 * zonas: zonas vigentes · limiteGeneral · hasta: segundos (o null = todo el video)
 */
export function calcularResultados({ demo, tablero, res, avisos, zonas, limiteGeneral, hasta }) {
  const fps = demo.fps;
  const durTotal = demo.duracion_s;
  const T = hasta == null ? durTotal : Math.min(hasta, durTotal);
  const nFin = hasta == null ? Infinity : T * fps + 1e-6;
  const intervalo = tablero.intervalo || 0.5;
  const metros = !!tablero.calibracion;
  const nombreZona = (z) => (zonas[z]?.nombre || "").trim() || `Zona ${z + 1}`;

  // ---------------- muestras cada 0.5 s (trayectorias de RegistroDatos), con las zonas vigentes
  const zonasEnMuestra = new Map();             // cuadro -> Map(pid -> [z])
  for (const m of res.muestras) if (m.n <= nFin) zonasEnMuestra.set(m.n, m.presentes);
  const codigos = (n, pid) => {
    const z = zonasEnMuestra.get(n)?.get(pid);
    return z && z.length ? z.map((k) => `Z${k + 1}`).join(", ") : "-";
  };
  const ejeX = tablero.ejes?.x || "centro_x", ejeY = tablero.ejes?.y || "centro_y";
  const tray = (tablero.trayectorias || []).filter((f) => f.frame <= nFin)
    .map((f) => ({ ...f, zona_actual: codigos(f.frame, f.id_camion) }))
    .sort((a, b) => a.tiempo_s - b.tiempo_s || a.id_camion - b.id_camion);
  const nombreCodigos = (c) => {
    if (!c || c === "-") return "Fuera de zonas";
    return c.split(",").map((x) => nombreZona(parseInt(x.trim().slice(1), 10) - 1)).join(", ") || "Fuera de zonas";
  };

  // ---------------- avisos hasta T
  const avisosT = avisos.filter((a) => a.tiempo_s <= T + 1e-6);
  const salidas = new Map(), ingresos = new Map();
  for (const a of avisosT) {
    if (a.tipo === "SALIDA_PANTALLA" && !salidas.has(a.id_camion)) salidas.set(a.id_camion, a.tiempo_s);
    if (a.tipo === "ENTRADA_PANTALLA" && !ingresos.has(a.id_camion)) ingresos.set(a.id_camion, a.tiempo_s);
  }

  // ---------------- camiones (RegistroDatos._resumen_camiones)
  const acum = new Map();                         // pid -> ultima fila de acumulados <= T
  for (const fila of tablero.acumulados || []) if (fila[0] <= nFin) acum.set(fila[1], fila);
  const primera = new Map(), ultima = new Map(), tInicioVel = new Map(), velMax = new Map();
  for (const [n, inferido, , filas, crudas] of demo.cuadros) {
    if (n > nFin) break;
    if (!inferido) continue;
    const t = n / fps;
    for (const [pid] of crudas) { if (!primera.has(pid)) primera.set(pid, t); ultima.set(pid, t); }
    for (const f of filas) {
      if (f[6] !== "D") continue;
      if (!tInicioVel.has(f[0])) tInicioVel.set(f[0], t);
      if (f[5] != null && t - tInicioVel.get(f[0]) >= demo.parametros.segundos_sin_velocidad) {
        velMax.set(f[0], Math.max(velMax.get(f[0]) || 0, f[5]));
      }
    }
  }
  const nExcesos = new Map();
  for (const e of res.excesos) if (e.t <= T + 1e-6) nExcesos.set(e.pid, (nExcesos.get(e.pid) || 0) + 1);
  const estimadas = new Map(), totalMuestras = new Map();
  for (const f of tray) {
    totalMuestras.set(f.id_camion, (totalMuestras.get(f.id_camion) || 0) + 1);
    if (f.estado !== "DETECTADO") estimadas.set(f.id_camion, (estimadas.get(f.id_camion) || 0) + 1);
  }
  // Entradas y permanencias en zonas (incluye las que siguen abiertas en T, como el Excel).
  const ev = res.eventosZona.filter((e) => e.t <= T + 1e-6);
  const entradas = new Map(), abiertas = new Map(), perm = new Map();
  const clave = (pid, z) => `${pid}|${z}`;
  for (const e of ev) {
    const k = clave(e.pid, e.z);
    if (e.tipo === "ENTRADA") { abiertas.set(k, e.t); (entradas.get(k) || entradas.set(k, []).get(k)).push(e.t); }
    else if (abiertas.has(k)) { (perm.get(k) || perm.set(k, []).get(k)).push(e.t - abiertas.get(k)); abiertas.delete(k); }
  }
  const tFinal = hasta == null ? (demo.cuadros[demo.cuadros.length - 1][0] / fps) : T;
  const permT = new Map([...perm].map(([k, v]) => [k, v.slice()]));
  for (const [k, t0] of abiertas) (permT.get(k) || permT.set(k, []).get(k)).push(tFinal - t0);

  const pids = [...acum.keys()].sort((a, b) => a - b);
  const camiones = pids.map((pid) => {
    const [, , tVis, tDet, tMov, dPx, dM] = acum.get(pid);
    const tot = totalMuestras.get(pid) || 0;
    const fila = {
      id_camion: pid, primera_aparicion_s: primera.get(pid) ?? 0, ultima_aparicion_s: ultima.get(pid) ?? 0,
      tiempo_visible_s: tVis, tiempo_detenido_s: tDet, tiempo_en_movimiento_s: tMov,
      porcentaje_detenido: tVis > 0 ? Math.round(1000 * tDet / tVis) / 10 : 0,
      distancia_px: dPx,
      porcentaje_posiciones_estimadas: tot ? Math.round(1000 * (estimadas.get(pid) || 0) / tot) / 10 : 0,
    };
    if (metros) {
      fila.distancia_m = Math.round(10 * (dM ?? 0)) / 10;
      fila.velocidad_media_en_movimiento_km_h = tMov > 0 ? Math.round(10 * (dM ?? 0) / tMov * 3.6) / 10 : 0;
      fila.velocidad_maxima_km_h = Math.round(10 * (velMax.get(pid) || 0)) / 10;
      fila.veces_sobre_el_limite = nExcesos.get(pid) || 0;
    }
    zonas.forEach((_, z) => {
      const ents = entradas.get(clave(pid, z)) || [];
      const p = permT.get(clave(pid, z)) || [];
      fila[`entradas_Z${z + 1}`] = ents.length;
      fila[`tiempo_total_en_Z${z + 1}_s`] = p.reduce((s, v) => s + v, 0);
      const ciclos = ents.slice(1).map((t, i) => t - ents[i]);
      fila[`ciclo_prom_Z${z + 1}_s`] = ciclos.length ? ciclos.reduce((s, v) => s + v, 0) / ciclos.length : null;
    });
    const primeraT = fila.primera_aparicion_s;
    fila.como = primeraT <= 2.0 ? "Al inicio del video" : ingresos.has(pid) ? "Entró por el borde" : "Apareció en la imagen";
    fila.salio = salidas.has(pid) ? salidas.get(pid) : null;
    return fila;
  });

  // ---------------- detenciones (_Datos._calcular_detenciones)
  const MIN = tablero.detencion_minima_s ?? 5, TOL = tablero.tolerancia_movimiento_s ?? 2;
  const porCamion = new Map();
  for (const f of tray) (porCamion.get(f.id_camion) || porCamion.set(f.id_camion, []).get(f.id_camion)).push(f);
  const detenciones = [];
  const huecoMax = TOL + intervalo + 1e-6;
  for (const [pid, filas] of [...porCamion].sort((a, b) => a[0] - b[0])) {
    const ultimaT = filas[filas.length - 1].tiempo_s;
    let grupo = [];
    const cerrar = () => {
      if (!grupo.length) return;
      const ini = grupo[0].tiempo_s, fin = grupo[grupo.length - 1].tiempo_s + intervalo, dur = fin - ini;
      if (dur < MIN) return;
      const cuenta = new Map();
      for (const g of grupo) cuenta.set(g.zona_actual, (cuenta.get(g.zona_actual) || 0) + 1);
      let lugar = "-", maxc = -1;
      for (const [k, v] of cuenta) if (v > maxc) { maxc = v; lugar = k; }      // most_common: primero gana empates
      const xs = grupo.map((g) => g[ejeX]).filter((v) => v != null), ys = grupo.map((g) => g[ejeY]).filter((v) => v != null);
      const notas = [];
      if (grupo[0] === filas[0]) notas.push("ya estaba detenido al aparecer");
      if (grupo[grupo.length - 1].tiempo_s >= ultimaT - 1e-6 && T - ultimaT <= 2 * intervalo + 0.5) notas.push("seguía detenido al terminar el análisis");
      detenciones.push({ camion: pid, inicio: ini, fin: Math.min(fin, T || fin), duracion: dur, lugar: nombreCodigos(lugar),
                         en_zona: lugar !== "-", x: xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null,
                         y: ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : null, nota: notas.join("; ") });
    };
    for (const f of filas) {
      if (f.movimiento !== "DETENIDO") continue;
      if (grupo.length && f.tiempo_s - grupo[grupo.length - 1].tiempo_s > huecoMax) { cerrar(); grupo = []; }
      grupo.push(f);
    }
    cerrar();
  }
  detenciones.sort((a, b) => a.inicio - b.inicio || a.camion - b.camion);
  const detPorCamion = new Map();
  for (const d of detenciones) (detPorCamion.get(d.camion) || detPorCamion.set(d.camion, []).get(d.camion)).push(d);
  for (const c of camiones) {
    const ds = detPorCamion.get(c.id_camion) || [];
    c.n_detenciones = ds.length;
    c.detencion_mas_larga_s = ds.reduce((m, d) => Math.max(m, d.duracion), 0);
  }

  // ---------------- reparto del tiempo de la flota (_Datos.reparto_tiempo)
  let mov = 0, detZona = 0, detFuera = 0;
  for (const f of tray) {
    if (f.movimiento === "EN_MOVIMIENTO") mov++;
    else if (f.zona_actual !== "-") detZona++;
    else detFuera++;
  }
  const reparto = [["En movimiento", mov * intervalo], ["Detenido en una zona", detZona * intervalo],
                   ["Detenido fuera de zonas", detFuera * intervalo]];

  // ---------------- zonas (RegistroDatos._resumen_zonas) y ocupacion
  const muestrasT = res.muestras.filter((m) => m.n <= nFin);
  const duracionH = Math.max(1e-9, tFinal / 3600);
  const zonasRes = zonas.map((zz, z) => {
    let total = 0;
    const p = [];
    for (const [k, v] of entradas) if (k.endsWith(`|${z}`)) total += v.length;
    for (const [k, v] of permT) if (k.endsWith(`|${z}`)) p.push(...v);
    const ocup = muestrasT.map((m) => m.ocupacion[z]);
    return {
      zona: `Z${z + 1}`, nombre_zona: nombreZona(z), tipo: zz.tipo, rol: zz.rol || "", limite: zz.limite,
      entradas_totales: total, camiones_por_hora: Math.round(10 * total / duracionH) / 10,
      permanencia_prom_s: p.length ? p.reduce((s, v) => s + v, 0) / p.length : null,
      permanencia_min_s: p.length ? Math.min(...p) : null, permanencia_max_s: p.length ? Math.max(...p) : null,
      ocupacion_promedio: ocup.length ? Math.round(100 * ocup.reduce((s, v) => s + v, 0) / ocup.length) / 100 : null,
      ocupacion_maxima: ocup.length ? Math.max(...ocup) : null,
    };
  });
  const paso = tFinal <= 600 ? 10 : tFinal <= 1800 ? 30 : 60;     // _Datos.ocupacion_intervalos
  const bloques = new Map();
  for (const m of muestrasT) {
    const b = Math.floor(m.t / paso);
    if (!bloques.has(b)) bloques.set(b, zonas.map(() => []));
    m.ocupacion.forEach((v, z) => bloques.get(b)[z].push(v));
  }
  const ocupacion = [...bloques.keys()].sort((a, b) => a - b).map((b) => ({
    desde: b * paso, promedio: bloques.get(b).map((v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0)),
    maximo: bloques.get(b).map((v) => (v.length ? Math.max(...v) : 0)) }));

  // ---------------- flujo del circuito (por el papel de cada zona)
  const flujo = ORDEN_ROLES.map((rol) => {
    const zs = zonasRes.filter((z) => z.rol === rol);
    if (!zs.length) return null;
    const p = [];
    zonas.forEach((zz, z) => { if (zz.rol === rol) for (const [k, v] of permT) if (k.endsWith(`|${z}`)) p.push(...v); });
    return { rol, nombre: ROLES[rol], zonas: zs.map((z) => z.nombre_zona),
             entradas: zs.reduce((s, z) => s + z.entradas_totales, 0),
             tiempo_prom_s: p.length ? p.reduce((s, v) => s + v, 0) / p.length : null,
             maximo_a_la_vez: Math.max(0, ...zs.map((z) => z.ocupacion_maxima || 0)) };
  }).filter(Boolean);

  // ---------------- avisos por tipo
  const conteoAvisos = new Map();
  for (const a of avisosT) {
    const k = TIPOS_AVISO[a.tipo] || a.titulo || "Otro";
    conteoAvisos.set(k, (conteoAvisos.get(k) || 0) + 1);
  }

  // ---------------- bitacora (zonas + avisos), como la hoja Bitacora
  const bitacora = [];
  for (const e of ev) {
    const nombre = nombreZona(e.z);
    if (e.tipo === "ENTRADA") bitacora.push({ t: e.t, camion: e.pid, evento: "Entrada a zona", zona: nombre, descripcion: `El camión ${e.pid} entró a ${nombre}.`, nivel: "info" });
    else bitacora.push({ t: e.t, camion: e.pid, evento: "Salida de zona", zona: nombre, descripcion: `El camión ${e.pid} salió de ${nombre}.`, nivel: "info" });
  }
  for (const a of avisosT) {
    if (a.tipo === "ENTRADA_ZONA") continue;
    bitacora.push({ t: a.tiempo_s, camion: a.id_camion, evento: TIPOS_AVISO[a.tipo] || a.titulo, zona: a.zona || "",
                    descripcion: a.detalle || "", nivel: a.nivel || "info" });
  }
  bitacora.sort((a, b) => a.t - b.t || (a.camion || 0) - (b.camion || 0));

  // ---------------- tarjetas (las de la hoja Resumen)
  const tVis = camiones.reduce((s, c) => s + c.tiempo_visible_s, 0);
  const tDet = camiones.reduce((s, c) => s + c.tiempo_detenido_s, 0);
  const tMov = camiones.reduce((s, c) => s + c.tiempo_en_movimiento_s, 0);
  const dist = camiones.reduce((s, c) => s + (metros ? c.distancia_m || 0 : c.distancia_px || 0), 0);
  const kpis = {
    camiones: camiones.length, distancia: dist, unidad: metros ? "m" : "px",
    velocidad_media: tMov > 0 ? (metros ? dist / tMov * 3.6 : dist / tMov) : 0, unidad_v: metros ? "km/h" : "px/s",
    pct_detenido: tVis > 0 ? tDet / tVis : 0, detenciones: detenciones.length,
    excesos: camiones.reduce((s, c) => s + (c.veces_sobre_el_limite || 0), 0), zonas: zonas.length,
  };

  const datos = { camiones, detenciones, zonas: zonasRes, alertas: avisosT, metros, limiteGeneral, salidas, ingresos, detPorCamion };
  return { T, completo: hasta == null, tray, camiones, detenciones, reparto, zonas: zonasRes, ocupacion, paso, flujo,
           conteoAvisos, bitacora, kpis, hallazgos: hallazgos(datos), metros, ejeX, ejeY };
}

// ---------------- hallazgos (reporte_excel._hallazgos, mismas frases)
function hallazgos(d) {
  const h = [];
  const cam = d.camiones.filter((c) => c.tiempo_visible_s);
  const lugaresDe = (pids) => {
    const l = new Map();
    for (const p of pids) for (const det of d.detPorCamion.get(p) || []) l.set(det.lugar, (l.get(det.lugar) || 0) + det.duracion);
    let mejor = null, max = -1;
    for (const [k, v] of l) if (v > max) { max = v; mejor = k; }
    return mejor;
  };
  let casiQuietos = [];
  if (cam.length) {
    casiQuietos = cam.filter((c) => (c.porcentaje_detenido || 0) >= 90);
    if (casiQuietos.length >= 2) {
      const donde = lugaresDe(casiQuietos.map((c) => c.id_camion));
      h.push(`${casiQuietos.length} de ${cam.length} camiones estuvieron detenidos más del 90 % del tiempo` +
             `${donde ? `, principalmente en ${donde}` : ""} (camiones: ${casiQuietos.map((c) => c.id_camion).join(", ")}).`);
    } else {
      const peor = cam.reduce((m, c) => ((c.porcentaje_detenido || 0) > (m.porcentaje_detenido || 0) ? c : m), cam[0]);
      const donde = lugaresDe([peor.id_camion]);
      h.push(`El camión ${peor.id_camion} fue el que más tiempo pasó detenido: ${f0(peor.porcentaje_detenido)} % del tiempo que se vio ` +
             `(${hms(peor.tiempo_detenido_s)})${donde ? `, sobre todo en ${donde}` : ""}.`);
    }
    const moviles = cam.filter((c) => (c.porcentaje_detenido ?? 100) < 90);
    if (casiQuietos.length >= 2 && moviles.length) {
      const pm = moviles.map((c) => 100 - c.porcentaje_detenido);
      h.push(`Los camiones que sí trabajaron (${moviles.map((c) => c.id_camion).join(", ")}) estuvieron en movimiento entre ` +
             `${f0(Math.min(...pm))} % y ${f0(Math.max(...pm))} % del tiempo.`);
    }
  }
  if (d.detenciones.length) {
    const larga = d.detenciones.reduce((m, x) => (x.duracion > m.duracion ? x : m), d.detenciones[0]);
    h.push(`La detención más larga fue del camión ${larga.camion}: ${hms(larga.duracion)} en ${larga.lugar} ` +
           `(empezó en el ${hms(larga.inicio)} del video).`);
  }
  const zs = d.zonas.filter((z) => z.ocupacion_maxima);
  if (zs.length) {
    const z = zs.reduce((m, x) => ((x.ocupacion_maxima > m.ocupacion_maxima ||
      (x.ocupacion_maxima === m.ocupacion_maxima && (x.ocupacion_promedio || 0) > (m.ocupacion_promedio || 0))) ? x : m), zs[0]);
    h.push(`La zona con más camiones a la vez fue ${z.nombre_zona}: hasta ${z.ocupacion_maxima} camiones ` +
           `(en promedio ${(z.ocupacion_promedio || 0).toFixed(1)}).`);
  }
  if (d.metros && cam.length) {
    const lejos = cam.reduce((m, c) => ((c.distancia_m || 0) > (m.distancia_m || 0) ? c : m), cam[0]);
    if ((lejos.distancia_m || 0) > 0) {
      h.push(`El camión ${lejos.id_camion} fue el que más recorrió: ${miles0(lejos.distancia_m)} m, a ` +
             `${f0(lejos.velocidad_media_en_movimiento_km_h)} km/h en promedio mientras avanzaba.`);
    }
  }
  const nExc = cam.reduce((s, c) => s + (c.veces_sobre_el_limite || 0), 0);
  if (nExc) {
    const rapido = cam.reduce((m, c) => ((c.velocidad_maxima_km_h || 0) > (m.velocidad_maxima_km_h || 0) ? c : m), cam[0]);
    const extra = rapido && rapido.velocidad_maxima_km_h ? `; la velocidad más alta fue del camión ${rapido.id_camion} (${f0(rapido.velocidad_maxima_km_h)} km/h)` : "";
    h.push(`Se registraron ${nExc} excesos de velocidad${extra}.`);
  } else if (d.metros && d.limiteGeneral) {
    h.push(`Ningún camión superó el límite de ${d.limiteGeneral} km/h.`);
  }
  if (d.salidas.size) {
    const alInicio = new Set(cam.filter((c) => (c.primera_aparicion_s || 0) <= 2.0).map((c) => c.id_camion));
    const nuevos = [...d.ingresos.keys()].filter((p) => !alInicio.has(p)).sort((a, b) => a - b);
    let texto = `${d.salidas.size} camión(es) salieron de la imagen (${[...d.salidas.keys()].sort((a, b) => a - b).join(", ")})`;
    if (nuevos.length) texto += `; los que entraron por el borde recibieron un número nuevo (${nuevos.join(", ")})`;
    h.push(texto + ".");
  }
  const est = cam.map((c) => c.porcentaje_posiciones_estimadas || 0);
  if (est.length && est.reduce((s, v) => s + v, 0) / est.length >= 30) {
    h.push(`El ${f0(est.reduce((s, v) => s + v, 0) / est.length)} % de las posiciones fueron estimadas (camiones juntos ` +
           "o tapados). Los tiempos son confiables; las distancias de esos tramos, aproximadas.");
  }
  if (!h.length) h.push("No hubo suficientes datos para sacar conclusiones.");
  return h.slice(0, 8);
}
